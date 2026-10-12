// =============================================================================
// Mail diagnostics (§43).
//
// Why this exists, stated plainly: this system once sat broken for an entire
// evening because the stored SMTP_PASSWORD was nine characters where the real
// App Password was sixteen — a shell paste that had split on a space. Nothing
// anywhere said so. The admin side reported "could not send", the function logs
// reported a 535, and every explanation on offer was a guess. Finding it took
// building a throwaway function to print the length of the secret.
//
// So that throwaway is now permanent, and it is the first action here. "diagnose"
// reports the shape of the configuration — never its contents — so that the next
// failure names itself instead of being theorised about.
//
// POST { action: "diagnose" }
//   What is configured, what is missing, and whether SMTP will accept a login.
//   Sends no mail.
//
// POST { action: "send", template, to }
//   One sample message, with visibly fake data, to one address.
//
// Administrator-only. Reaching this URL proves nothing (§24).
// =============================================================================

import { json, preflight, requireAdmin, serviceClient } from "../_shared/deps.ts";
import {
  invitationEmail, confirmationEmail, registrationNoticeEmail, helperRequestEmail,
  openMailer,
} from "../_shared/email.ts";

// Sample data. Deliberately absurd names: if one of these ever reaches a real
// parent, it should be instantly obvious that it was a test and not a notice
// about their own children.
const SAMPLE_FAMILY = "Testerly Family";
const SAMPLE_PARENT = "Test Testerly";
const SAMPLE_SEMESTER = "Test Semester 2099";
const SAMPLE_URL = "https://example.invalid/coop/register/#SAMPLE-LINK-NOT-REAL";

const TEMPLATES = [
  "invitation", "confirmation", "registration_notice", "helper_request",
] as const;
type Template = typeof TEMPLATES[number];

/** Is this a time zone the runtime will actually accept? */
function tzOk(tz: string | null): boolean {
  if (!tz) return false;
  try {
    new Date().toLocaleDateString("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const db = serviceClient();
  const admin = await requireAdmin(req, db);
  if (!admin) return json(req, { ok: false, error: "Not authorised" }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { body = {}; }
  const action = String(body.action ?? "diagnose");

  const { data: s } = await db.from("settings").select("*").eq("id", 1).single();

  // ---------------------------------------------------------------------------
  // diagnose — report shape, never contents
  // ---------------------------------------------------------------------------
  if (action === "diagnose") {
    const user = (Deno.env.get("SMTP_USER") ?? "").trim();
    const rawPass = Deno.env.get("SMTP_PASSWORD") ?? "";
    const pass = rawPass.replace(/\s+/g, "");
    const host = Deno.env.get("SMTP_HOST") ?? "smtp.gmail.com";
    const port = Number(Deno.env.get("SMTP_PORT") ?? "465");

    const checks: { label: string; ok: boolean; detail: string }[] = [];

    checks.push({
      label: "SMTP username",
      ok: !!user,
      detail: user || "Not set. Set the SMTP_USER secret in Supabase.",
    });

    // The length is the whole point of this page. A Gmail App Password is
    // exactly sixteen characters; anything else is the bug, stated out loud.
    checks.push({
      label: "SMTP password",
      ok: pass.length === 16,
      detail: !pass
        ? "Not set. Set the SMTP_PASSWORD secret in Supabase."
        : pass.length === 16
          ? "16 characters — the right length for a Gmail App Password."
          : `${pass.length} characters, expected 16. This is almost certainly `
            + `the problem: a Gmail App Password is 16 characters. If it was `
            + `pasted into a shell without quotes it will have been cut at the `
            + `first space.`,
    });

    if (rawPass !== pass && rawPass.trim() !== pass) {
      checks.push({
        label: "Password whitespace",
        ok: true,
        detail: "The stored value contains spaces. They are stripped before "
          + "use, so this is harmless — Google displays App Passwords in "
          + "groups of four.",
      });
    }

    checks.push({
      label: "Mail server",
      ok: !!host && !!port,
      detail: `${host}:${port}${port === 465 ? " (implicit TLS)" : port === 587 ? " (STARTTLS)" : ""}`,
    });

    checks.push({
      label: "Sending address",
      ok: !!s?.from_email,
      detail: s?.from_email
        ? s.from_email === user
          ? `${s.from_email} — matches the SMTP account.`
          : `${s.from_email}. This differs from the SMTP account (${user}). `
            + `Gmail refuses a From that is neither the account nor a verified `
            + `alias, so check that this is set up as an alias.`
        : "Not set, in Settings → Program.",
    });

    checks.push({
      label: "Reply-to address",
      ok: true,
      detail: s?.reply_to_email || "Not set — replies will go to the sending address.",
    });

    // Caught the hard way: "America/Arizona" is not an IANA zone. The code that
    // formats closing dates catches its own error, so the dates simply vanished
    // from every email and nothing was reported.
    checks.push({
      label: "Time zone",
      ok: tzOk(s?.timezone),
      detail: tzOk(s?.timezone)
        ? `${s?.timezone} — valid.`
        : `"${s?.timezone ?? "not set"}" is not a time zone this server `
          + `recognises. Closing dates will be left out of emails entirely `
          + `rather than shown wrongly. Use an IANA name such as America/Phoenix.`,
    });

    // Deliberately *not* called a sign-in test. The mail library connects
    // lazily — it does not touch the network until the first message — so this
    // confirms only that a client could be built from the settings above. It
    // read "sign-in OK" while the password was nine characters long, which is
    // the precise species of false green this page exists to abolish. The only
    // honest proof of delivery is sending something, which is the next card.
    const mailer = await openMailer(db);
    checks.push({
      label: "Ready to send",
      ok: mailer.ready,
      detail: mailer.ready
        ? "Nothing is missing. This has not contacted the mail server — only a "
          + "real send proves delivery, so send a sample below."
        : mailer.error ?? "Unknown failure",
    });
    await mailer.close();

    return json(req, {
      ok: checks.every((c) => c.ok),
      checks,
      templates: TEMPLATES,
    });
  }

  // ---------------------------------------------------------------------------
  // send — one sample message
  // ---------------------------------------------------------------------------
  if (action === "send") {
    const to = String(body.to ?? "").trim();
    const template = String(body.template ?? "") as Template;

    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
      return json(req, { ok: false, error: "Give an address to send to." }, 400);
    }
    if (!TEMPLATES.includes(template)) {
      return json(req, { ok: false, error: `Unknown template "${template}".` }, 400);
    }

    const programName = s?.program_name ?? "Homeschool Co-op";
    let mail: { subject: string; html: string; text: string };

    switch (template) {
      case "invitation":
        mail = invitationEmail({
          programName, familyName: SAMPLE_FAMILY, semesterName: SAMPLE_SEMESTER,
          registerUrl: SAMPLE_URL, closesAt: "December 31, 2099",
        });
        break;

      case "confirmation":
        mail = confirmationEmail({
          programName, familyName: SAMPLE_FAMILY, semesterName: SAMPLE_SEMESTER,
          manageUrl: SAMPLE_URL,
          schedules: [
            { childName: "Sample Child One", rows: [
              { period: "First Period", className: "Test Class A" },
              { period: "Second Period", className: "Test Class B", waitlisted: true, position: 2 },
            ] },
            { childName: "Sample Child Two", rows: [
              { period: "First Period", className: "Test Class C" },
            ] },
          ],
        });
        break;

      case "registration_notice":
        mail = registrationNoticeEmail({
          programName, familyName: SAMPLE_FAMILY, semesterName: SAMPLE_SEMESTER,
          portalUrl: SAMPLE_URL, closesAt: "December 31, 2099",
        });
        break;

      case "helper_request":
        // Uses the saved wording, so this previews what parents will really
        // get — including any edits made on the helper email page.
        mail = helperRequestEmail({
          programName, parentName: SAMPLE_PARENT, semesterName: SAMPLE_SEMESTER,
          portalUrl: SAMPLE_URL,
          subject: s?.helper_email_subject ?? null,
          body: s?.helper_email_body ?? null,
        });
        break;
    }

    const mailer = await openMailer(db);
    if (!mailer.ready) {
      return json(req, { ok: false, error: mailer.error, stage: "connect" });
    }

    // Marked in the subject, and again at the top of the body, because a test
    // that looks exactly like the real thing is its own small hazard.
    const banner = `This is a test message sent from the co-op administration `
      + `site by ${admin.display_name ?? admin.email}. The names, dates and `
      + `links in it are not real.`;

    const sent = await mailer.send({
      to,
      subject: `[TEST] ${mail.subject}`,
      html: mail.html.replace(
        /(<div style="max-width:560px[^>]*>)/,
        `$1<div style="background:#fff4d6;border:1px solid #e0c269;padding:12px 14px;`
        + `border-radius:4px;font-size:13px;color:#6b5420;margin-bottom:24px;">${banner}</div>`,
      ),
      text: `*** ${banner} ***\n\n${mail.text}`,
    });
    await mailer.close();

    if (!sent.ok) {
      return json(req, { ok: false, error: sent.error, stage: "send" });
    }
    return json(req, { ok: true, to, template, subject: `[TEST] ${mail.subject}` });
  }

  return json(req, { ok: false, error: `Unknown action "${action}".` }, 400);
});
