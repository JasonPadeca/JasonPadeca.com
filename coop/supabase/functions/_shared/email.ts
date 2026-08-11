// Email, isolated behind one interface (§26).
//
// The rest of the system calls openMailer()/sendEmail() and never names a
// provider. Swapping transports means rewriting the block below and nothing
// else — no database change, no template change, no caller change. That
// promise has now been cashed once: this started as Brevo's HTTP API and
// became SMTP without anything outside this file moving.
//
// SMTP rather than a transactional-email API, because a co-op sending ~35
// invitations twice a year does not need a relay in the middle. Sending
// straight from the co-op's own mailbox means no sender-verification dance,
// and mail that genuinely originates from the address families already know —
// which is also the best thing you can do for deliverability.
//
// Nothing here is Gmail-specific beyond the default hostname and port, so a
// Workspace account, Fastmail, or a hosting provider's SMTP all work by
// setting SMTP_HOST and SMTP_PORT.

import { esc, type SupabaseClient } from "./deps.ts";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

export interface Email {
  to: string;
  toName?: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

interface Sender {
  fromEmail: string;
  fromName: string;
  replyTo?: string;
}

// --- Transport ---------------------------------------------------------------

function smtpConfig() {
  const user = Deno.env.get("SMTP_USER");
  // App Passwords are displayed in four groups of four; people paste the
  // spaces along with them, and the server rejects that without explanation.
  const pass = (Deno.env.get("SMTP_PASSWORD") ?? "").replace(/\s+/g, "");
  const host = Deno.env.get("SMTP_HOST") ?? "smtp.gmail.com";
  const port = Number(Deno.env.get("SMTP_PORT") ?? "465");
  return { user, pass, host, port };
}

/**
 * A live SMTP connection.
 *
 * Opening registration sends one message per family, and dialling SMTP
 * separately for each would spend most of its time on handshakes — with a real
 * risk of hitting the function's wall clock on a larger co-op. One connection
 * carries the whole batch.
 */
export interface Mailer {
  send(email: Email): Promise<SendResult>;
  close(): Promise<void>;
  ready: boolean;
  error?: string;
}

export async function openMailer(db: SupabaseClient): Promise<Mailer> {
  const { user, pass, host, port } = smtpConfig();
  const { data: s } = await db.from("settings").select("*").eq("id", 1).single();

  const sender: Sender = {
    // Gmail rejects a From that is neither the authenticated account nor one of
    // its verified aliases, so the account address is the safe fallback.
    fromEmail: s?.from_email || user || "",
    fromName: s?.from_name || s?.program_name || "Homeschool Co-op",
    replyTo: s?.reply_to_email || undefined,
  };

  const fail = (error: string): Mailer => ({
    ready: false, error,
    send: () => Promise.resolve({ ok: false, error }),
    close: () => Promise.resolve(),
  });

  if (!user || !pass) {
    return fail("SMTP_USER and SMTP_PASSWORD are not configured in Supabase.");
  }
  if (!sender.fromEmail) {
    return fail("No sending address configured in Settings.");
  }

  let client: SMTPClient;
  try {
    client = new SMTPClient({
      connection: {
        hostname: host,
        port,
        // Port 465 is implicit TLS; 587 negotiates STARTTLS instead.
        tls: port === 465,
        auth: { username: user, password: pass },
      },
    });
  } catch (e) {
    return fail(`Could not open a mail connection: ${msg(e)}`);
  }

  return {
    ready: true,
    async send(email: Email): Promise<SendResult> {
      if (!email.to) return { ok: false, error: "No recipient address" };
      try {
        await client.send({
          from: `${sender.fromName} <${sender.fromEmail}>`,
          to: email.toName ? `${email.toName} <${email.to}>` : email.to,
          replyTo: sender.replyTo,
          subject: email.subject,
          content: email.text,
          html: email.html,
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: friendlySmtpError(msg(e)) };
      }
    },
    async close() {
      try { await client.close(); } catch { /* already gone */ }
    },
  };
}

/** One-off send. Opens a connection, sends, closes. */
export async function sendEmail(db: SupabaseClient, email: Email): Promise<SendResult> {
  const mailer = await openMailer(db);
  if (!mailer.ready) return { ok: false, error: mailer.error };
  try {
    return await mailer.send(email);
  } finally {
    await mailer.close();
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** SMTP errors are terse and numeric. Say what to actually do about them. */
function friendlySmtpError(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes("535") || s.includes("username and password not accepted")) {
    return "The mail server rejected the username or password. For Gmail this must be a 16-character App Password, not the account password, and the account needs 2-Step Verification switched on.";
  }
  if (s.includes("534")) {
    return "Gmail requires an App Password for this account. Turn on 2-Step Verification, then generate one.";
  }
  if (s.includes("550") || s.includes("553")) {
    return "The mail server refused the From address. It must be the account you are signing in as, or one of its verified aliases.";
  }
  if (s.includes("timeout") || s.includes("connection")) {
    return `Could not reach the mail server: ${raw}`;
  }
  return raw;
}

// --- Templates ---------------------------------------------------------------
//
// Plain, table-free HTML with inline styles: co-op parents will open these in
// Gmail, Outlook, and a phone, and the fanciest layout is the one that renders
// the same in all three. Every template also ships a text/plain alternative.

function layout(programName: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f6f5f3;">
<div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#23201d;">
  <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8a7f73;margin-bottom:24px;">${esc(programName)}</div>
  ${bodyHtml}
  <div style="margin-top:36px;padding-top:16px;border-top:1px solid #e3ded7;font-size:13px;color:#8a7f73;">
    You are receiving this because your family participates in ${esc(programName)}.
  </div>
</div></body></html>`;
}

function button(url: string, label: string): string {
  return `<p style="margin:28px 0;">
    <a href="${esc(url)}" style="display:inline-block;background:#8b7355;color:#fff;text-decoration:none;padding:13px 26px;border-radius:4px;font-weight:600;">${esc(label)}</a>
  </p>
  <p style="font-size:13px;color:#8a7f73;">If the button does not work, copy this address into your browser:<br>
  <span style="word-break:break-all;">${esc(url)}</span></p>`;
}

export function invitationEmail(opts: {
  programName: string;
  familyName: string;
  semesterName: string;
  registerUrl: string;
  closesAt?: string | null;
}): Email {
  const closing = opts.closesAt
    ? `<p>Class sign-up closes <strong>${esc(opts.closesAt)}</strong>.</p>` : "";

  const html = layout(opts.programName, `
    <h1 style="font-size:24px;margin:0 0 16px;font-weight:600;">${esc(opts.semesterName)} Class Sign-Up Is Open</h1>
    <p>Class sign-up is now open for the <strong>${esc(opts.familyName)}</strong>.</p>
    <p>Use the button below to choose classes for ${esc(opts.semesterName)}.</p>
    ${button(opts.registerUrl, "Choose Classes")}
    ${closing}
    <p style="font-size:14px;color:#6b625a;background:#efece7;padding:12px 14px;border-radius:4px;">
      This link is specific to your family. Please do not share it.
    </p>`);

  const text = [
    `${opts.semesterName} Class Sign-Up Is Open`, "",
    `Class sign-up is now open for the ${opts.familyName}.`,
    `Choose classes here:`, opts.registerUrl, "",
    opts.closesAt ? `Class sign-up closes ${opts.closesAt}.\n` : "",
    `This link is specific to your family. Please do not share it.`,
  ].join("\n");

  return {
    to: "", // filled by the caller
    subject: `${opts.semesterName} Co-op Class Sign-Up Is Open`,
    html, text,
  };
}

export interface ChildSchedule {
  childName: string;
  rows: { period: string; className: string; waitlisted?: boolean; position?: number | null }[];
}

export function confirmationEmail(opts: {
  programName: string;
  familyName: string;
  semesterName: string;
  schedules: ChildSchedule[];
  manageUrl?: string;
}): Email {
  const blocks = opts.schedules.map((c) => {
    const rows = c.rows.length
      ? c.rows.map((r) =>
          `<div style="padding:4px 0;">${esc(r.period)} — ${esc(r.className)}${
            r.waitlisted
              ? ` <span style="color:#9a6b3f;">(waitlist${r.position ? ` #${r.position}` : ""})</span>`
              : ""
          }</div>`).join("")
      : `<div style="padding:4px 0;color:#8a7f73;">No classes selected</div>`;
    return `<div style="margin:20px 0;padding:16px 18px;background:#efece7;border-radius:6px;">
      <div style="font-weight:600;margin-bottom:6px;">${esc(c.childName)}</div>${rows}</div>`;
  }).join("");

  const html = layout(opts.programName, `
    <h1 style="font-size:24px;margin:0 0 16px;font-weight:600;">Registration Confirmed</h1>
    <p>Your registration for <strong>${esc(opts.semesterName)}</strong> has been saved.</p>
    ${blocks}
    ${opts.manageUrl ? button(opts.manageUrl, "View or Change Registration") : ""}`);

  const text = [
    `${opts.semesterName} Registration Confirmation — ${opts.familyName}`, "",
    `Your registration has been saved.`, "",
    ...opts.schedules.map((c) =>
      [c.childName, ...c.rows.map((r) =>
        `  ${r.period} — ${r.className}${r.waitlisted ? ` (waitlist${r.position ? ` #${r.position}` : ""})` : ""}`,
      ), ""].join("\n")),
    opts.manageUrl ? `View or change your registration:\n${opts.manageUrl}` : "",
  ].join("\n");

  return {
    to: "",
    subject: `${opts.semesterName} Registration Confirmation — ${opts.familyName}`,
    html, text,
  };
}


/**
 * "Registration is open — come and register."
 *
 * Not the same message as an invitation, and deliberately not built the same
 * way. An invitation carries a token that IS the credential, so it is personal
 * and must not be forwarded. This carries no token at all: it points at the
 * portal, where a family signs in with the address the co-op already holds.
 *
 * That difference matters for a forwarded email. A shared invitation link is
 * somebody else's registration; a shared link to this is a sign-in page that
 * will not recognise them.
 */
export function registrationNoticeEmail(opts: {
  programName: string;
  familyName: string;
  semesterName: string;
  portalUrl: string;
  closesAt?: string | null;
}): Email {
  const closing = opts.closesAt
    ? `<p>Registration closes <strong>${esc(opts.closesAt)}</strong>.</p>` : "";

  const html = layout(opts.programName, `
    <h1 style="font-size:24px;margin:0 0 16px;font-weight:600;">Registration for ${esc(opts.semesterName)} Is Open</h1>
    <p>Hello ${esc(opts.familyName)},</p>
    <p>It is time to register for <strong>${esc(opts.semesterName)}</strong>. Sign in
       and you will find most of the form already filled in from what we have on
       file — check it over, add a grade for each child, and send it.</p>
    ${button(opts.portalUrl, "Register For This Semester")}
    ${closing}
    <p>Choosing classes happens separately, once your registration has been
       received and the fee is settled. We will email you again when that opens.</p>
    <p style="font-size:14px;color:#6b625a;background:#efece7;padding:12px 14px;border-radius:4px;">
      Sign in with this email address — the one this message was sent to. There
      is no password; you will be sent a code.
    </p>`);

  const text = [
    `Registration for ${opts.semesterName} Is Open`, "",
    `Hello ${opts.familyName},`, "",
    `It is time to register for ${opts.semesterName}. Sign in and most of the`,
    `form will already be filled in from what we have on file.`, "",
    opts.portalUrl, "",
    opts.closesAt ? `Registration closes ${opts.closesAt}.\n` : "",
    `Choosing classes happens separately, once your registration has been`,
    `received. We will email you again when that opens.`, "",
    `Sign in with this email address. There is no password; you will be sent a code.`,
  ].join("\n");

  return {
    to: "",
    subject: `Registration for ${opts.semesterName} Is Open`,
    html,
    text,
  };
}
