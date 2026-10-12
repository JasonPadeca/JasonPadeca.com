// =============================================================================
// Mail diagnostics (§43). A subpage of Settings.
//
// This page is the answer to a specific bad evening. Registration mail had
// stopped, the only symptom available was "it didn't send", and the cause — a
// stored password nine characters long where the real one was sixteen — was
// invisible from every surface anybody could look at. Diagnosis was guesswork
// for hours.
//
// So this page reports the *shape* of the configuration before anything is
// sent: whether each secret is set, whether the password is the right length,
// whether the sending address matches the account Gmail will authenticate,
// whether the time zone is one the server actually knows, and whether SMTP
// accepts a sign-in at all. Then it sends real samples of each template.
//
// It never displays a secret. The password appears only as a character count,
// which is the one fact about it that has ever been diagnostically useful.
// =============================================================================

import { api } from "../../assets/api.js";
import { esc, $, $$, render, toastOk, toastErr } from "../../assets/ui.js";
import { ADMIN } from "../app.js";

// Every template the system can send, in the order a family meets them.
const TEMPLATES = [
  ["registration_notice", "Registration is open",
   "Sent to every family when registration opens for a semester."],
  ["invitation", "Class sign-up is open",
   "Sent when class sign-up opens. The real one carries a link unique to the family."],
  ["confirmation", "Class choices received",
   "Sent back to a family after they choose classes, listing what each child got."],
  ["helper_request", "Can you help with a class?",
   "Sent when asking parents to volunteer. Uses the wording saved on the helper email page."],
];

export async function show(app) {
  render(app, `<div class="wrap page">
    <div class="crumbs"><a href="#/settings">Settings</a><span>›</span>Email</div>
    <div class="page-head"><div>
      <h1>Email</h1>
      <div class="sub">Check the mail setup, and send yourself a sample of each message</div>
    </div></div>

    <div class="card">
      <div class="card-head"><h3>Configuration</h3>
        <button class="btn btn-sm" id="recheck">Check again</button></div>
      <div id="checks"><p class="muted">Checking…</p></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Send a sample</h3></div>
      <p class="muted">Each one is a real send through the real mail server, so
        it tests the whole path. The names, dates and links inside are obviously
        fake, and the subject is prefixed <code>[TEST]</code>.</p>

      <div class="field mt">
        <label for="to">Send to</label>
        <input type="email" id="to" value="${esc(ADMIN?.email ?? "")}">
        <div class="hint">Your own address, normally.</div>
      </div>

      <div class="mt">${TEMPLATES.map(([id, label, note]) => `
        <div class="onfile-row" style="align-items:flex-start;gap:12px">
          <div style="flex:1">
            <strong>${esc(label)}</strong>
            <div class="tiny faint">${esc(note)}</div>
          </div>
          <button class="btn btn-sm send" data-template="${esc(id)}">Send</button>
          <span class="tiny result" data-for="${esc(id)}"></span>
        </div>`).join("")}</div>
    </div>
  </div>`);

  $("#recheck", app).addEventListener("click", () => diagnose(app));
  $$(".send", app).forEach((b) =>
    b.addEventListener("click", () => sendOne(app, b)));

  await diagnose(app);
}

async function diagnose(app) {
  const host = $("#checks", app);
  render(host, `<p class="muted">Checking…</p>`);

  let res;
  try {
    res = await api.emailDiagnose();
  } catch (e) {
    return render(host, `<div class="note note-danger">${esc(e.message)}</div>`);
  }

  if (!res?.checks) {
    return render(host, `<div class="note note-danger">
      ${esc(res?.error ?? "The check could not be run.")}
      <div class="mt tiny">If this says the function was not found, the
        <code>test-email</code> function has not been deployed yet.</div>
    </div>`);
  }

  // A single verdict line first. Somebody arriving here because mail is broken
  // wants the answer before the detail.
  const bad = res.checks.filter((c) => !c.ok);

  render(host, `
    <div class="note ${bad.length ? "note-danger" : "note-ok"}">
      <strong>${bad.length
        ? `${bad.length} problem${bad.length === 1 ? "" : "s"} found.`
        : "Everything checks out."}</strong>
      ${bad.length
        ? `<div class="mt">${esc(bad.map((c) => c.label).join(", "))}.</div>`
        : `<div class="mt">Nothing is missing from the setup. That is not the
            same as proof — only a real send tests delivery, so send yourself a
            sample below.</div>`}
    </div>

    <div class="table-scroll mt"><table><tbody>
      ${res.checks.map((c) => `<tr>
        <td class="nowrap" style="width:1%">${c.ok
          ? `<span style="color:#2f7d4f">✓</span>`
          : `<span style="color:#b3261e">✕</span>`}</td>
        <th class="nowrap">${esc(c.label)}</th>
        <td class="small">${esc(c.detail)}</td>
      </tr>`).join("")}
    </tbody></table></div>

    <p class="tiny faint mt">The password is never shown here — only its length,
      which is the part that tells you whether it is a valid App Password.</p>`);
}

async function sendOne(app, btn) {
  const template = btn.dataset.template;
  const to = $("#to", app).value.trim();
  const out = $(`.result[data-for="${template}"]`, app);

  if (!to) {
    toastErr("Put in an address to send to.");
    $("#to", app).focus();
    return;
  }

  btn.disabled = true;
  out.textContent = "Sending…";
  out.className = "tiny result muted";

  try {
    const res = await api.sendTestEmail(template, to);
    if (!res?.ok) throw new Error(res?.error ?? "The message could not be sent.");
    out.textContent = "Sent";
    out.className = "tiny result";
    out.style.color = "#2f7d4f";
    toastOk(`Sent to ${to}.`);
  } catch (e) {
    out.textContent = "Failed";
    out.className = "tiny result";
    out.style.color = "#b3261e";
    // The real SMTP text, not a shrug. This is the whole point of the page.
    toastErr(e.message);
  } finally {
    btn.disabled = false;
  }
}
