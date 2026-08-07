// Email, isolated behind one interface (§26).
//
// The rest of the system calls sendEmail() and never mentions Brevo. Swapping
// providers later means rewriting the transport function below and nothing
// else — no database change, no template change, no caller change.

import { esc, type SupabaseClient } from "./deps.ts";

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

// --- Transport -------------------------------------------------------------

async function sendViaBrevo(email: Email, sender: Sender): Promise<SendResult> {
  const key = Deno.env.get("BREVO_API_KEY");
  if (!key) return { ok: false, error: "BREVO_API_KEY is not configured" };

  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        sender: { email: sender.fromEmail, name: sender.fromName },
        to: [{ email: email.to, name: email.toName }],
        replyTo: sender.replyTo ? { email: sender.replyTo } : undefined,
        subject: email.subject,
        htmlContent: email.html,
        textContent: email.text,
      }),
    });

    if (!res.ok) {
      return { ok: false, error: `Brevo ${res.status}: ${(await res.text()).slice(0, 300)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Brevo request failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function sendEmail(db: SupabaseClient, email: Email): Promise<SendResult> {
  const { data: s } = await db.from("settings").select("*").eq("id", 1).single();

  const sender: Sender = {
    fromEmail: s?.from_email ?? Deno.env.get("DEFAULT_FROM_EMAIL") ?? "",
    fromName: s?.from_name ?? s?.program_name ?? "Homeschool Co-op",
    replyTo: s?.reply_to_email ?? undefined,
  };

  if (!sender.fromEmail) {
    return { ok: false, error: "No sending address configured in Settings" };
  }
  if (!email.to) {
    return { ok: false, error: "No recipient address" };
  }

  return await sendViaBrevo(email, sender);
}

// --- Templates -------------------------------------------------------------
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
    ? `<p>Registration closes <strong>${esc(opts.closesAt)}</strong>.</p>` : "";

  const html = layout(opts.programName, `
    <h1 style="font-size:24px;margin:0 0 16px;font-weight:600;">${esc(opts.semesterName)} Registration Is Open</h1>
    <p>Registration is now open for the <strong>${esc(opts.familyName)}</strong>.</p>
    <p>Use the button below to register your children for ${esc(opts.semesterName)}.</p>
    ${button(opts.registerUrl, "Register Your Family")}
    ${closing}
    <p style="font-size:14px;color:#6b625a;background:#efece7;padding:12px 14px;border-radius:4px;">
      This registration link is specific to your family. Please do not share it.
    </p>`);

  const text = [
    `${opts.semesterName} Registration Is Open`, "",
    `Registration is now open for the ${opts.familyName}.`,
    `Register your children here:`, opts.registerUrl, "",
    opts.closesAt ? `Registration closes ${opts.closesAt}.\n` : "",
    `This registration link is specific to your family. Please do not share it.`,
  ].join("\n");

  return {
    to: "", // filled by the caller
    subject: `${opts.semesterName} Co-op Registration Is Open`,
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
