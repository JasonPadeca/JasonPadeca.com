// =============================================================================
// A registration or an application, on paper.
//
// The record is the rows in the database; this is a view of them. But it is the
// view that matters when somebody asks a question in November, so it is laid
// out to be read cold by a person who was not in the room — dated, signed by
// whoever did what, and carrying the ages the co-op believed at the time rather
// than the ages a recalculation would produce today.
//
// The drift notice is the reason this exists. It is worded as a fact, not an
// accusation: dates of birth do get corrected, and a family that has to ring
// the registrar to fix a typo is a family that stops using the software. What
// the paper does is make sure a change cannot pass unnoticed.
// =============================================================================

import { api } from "../../assets/api.js";
import { esc, $, render, fmtDate, fmtDateTime } from "../../assets/ui.js";

const PRINTED = () => new Date().toLocaleString(undefined,
  { dateStyle: "long", timeStyle: "short" });

// -----------------------------------------------------------------------------
// A registration
// -----------------------------------------------------------------------------
export async function registration(app, params) {
  let rec;
  try {
    rec = await api.registrationRecord(params.family, params.semester);
  } catch (e) {
    return render(app, `<div class="wrap page">
      <div class="note note-danger">${esc(e.message)}</div>
      <p class="muted mt">If this says the function could not be found, the
      database update that adds it has not been run yet.</p></div>`);
  }

  if (!rec?.ok) {
    return render(app, `<div class="wrap page"><div class="empty">
      <h3>No registration to print</h3>
      <p>This family has not registered for that semester.</p>
      <p><a href="#/registration">Back to Registration</a></p>
    </div></div>`);
  }

  const s = rec.snapshot;

  render(app, `
    <div class="sheet-actions no-print">
      <a class="btn" href="#/registration">← Back</a>
      <button class="btn btn-primary" onclick="window.print()">Print</button>
    </div>

    <div class="sheet">
      <header class="sheet-head">
        <div>
          <h1>${esc(s?.family?.display_name ?? "Registration")}</h1>
          <div class="sheet-sub">Registration for ${esc(s?.semester?.name ?? "")}</div>
        </div>
        <div class="sheet-meta">
          <div>Koinonia Homeschool Group</div>
          <div>Printed ${esc(PRINTED())}</div>
        </div>
      </header>

      ${recordBody(rec, { forPrint: true })}

      <footer class="sheet-foot">
        This is a record of what Koinonia Homeschool Group held for this family
        at the time of registration.
      </footer>
    </div>`);
}

// -----------------------------------------------------------------------------
// An application
// -----------------------------------------------------------------------------
export async function application(app, params) {
  let rec;
  try {
    rec = await api.applicationRecord(params.id);
  } catch (e) {
    return render(app, `<div class="wrap page">
      <div class="note note-danger">${esc(e.message)}</div></div>`);
  }

  if (!rec?.ok) {
    return render(app, `<div class="wrap page"><div class="empty">
      <h3>No such application</h3>
      <p><a href="#/applications">Back to Applications</a></p></div></div>`);
  }

  const a = rec.answers;

  render(app, `
    <div class="sheet-actions no-print">
      <a class="btn" href="#/applications">← Back</a>
      <button class="btn btn-primary" onclick="window.print()">Print</button>
    </div>

    <div class="sheet">
      <header class="sheet-head">
        <div>
          <h1>${esc(a.parent_names ?? "Application")}</h1>
          <div class="sheet-sub">Application for membership</div>
        </div>
        <div class="sheet-meta">
          <div>Koinonia Homeschool Group</div>
          <div>Printed ${esc(PRINTED())}</div>
        </div>
      </header>

      <section>
        <table class="sheet-table">
          <tbody>
            ${line("Sent", fmtDateTime(rec.submitted_at))}
            ${line("Status", rec.status)}
            ${rec.reviewed_at ? line("Decided", fmtDateTime(rec.reviewed_at)) : ""}
            ${rec.admin_notes ? line("Note", rec.admin_notes) : ""}
          </tbody>
        </table>
      </section>

      <section>
        <h2>What they wrote</h2>
        <table class="sheet-table">
          <tbody>
            ${line("Parents", a.parent_names)}
            ${line("Email", a.email)}
            ${line("Phone", a.phone)}
            ${line("Children", a.children_text)}
            ${line("Agrees with the statement of beliefs",
                   a.agrees_to_beliefs ? "Yes" : "No")}
            ${line("How they heard about the co-op", a.heard_about)}
            ${line("Their homeschooling so far", a.homeschool_journey)}
            ${line("About themselves", a.about_yourself)}
            ${line("What they are looking for", a.looking_for)}
          </tbody>
        </table>
      </section>

      <footer class="sheet-foot">
        This is the application exactly as it was submitted. Nothing here can be
        edited after sending.
      </footer>
    </div>`);
}


// =============================================================================
// The body of a registration record.
//
// Exported, because the desk shows the same thing in a dialog and the two used
// to disagree: the dialog rendered the thin payload the browser had sent —
// phone, a comment, and a list of grades with no names against them — while the
// sheet rendered the snapshot. One of those was worth reading.
//
// Now there is one renderer. Whatever the paper shows, the dialog shows.
// =============================================================================
export function recordBody(rec, { forPrint = false } = {}) {
  const s = rec.snapshot;
  const a = rec.answers ?? {};
  const drift = rec.drift;

  return `
    ${drift === null ? `<div class="sheet-note">
      This was submitted before records were kept, so there is no snapshot of
      what the co-op held at the time.</div>` : ""}

    ${Array.isArray(drift) && drift.length ? `<div class="sheet-alert">
      <strong>Details have changed since this was submitted.</strong>
      <ul>${drift.map((d) => `<li>${esc(d.child)}: ${esc(d.field)} was
        <strong>${esc(d.was ?? "blank")}</strong>, now
        <strong>${esc(d.now ?? "blank")}</strong></li>`).join("")}</ul>
      <div class="tiny">A correction is an ordinary reason for this. It is shown
        so it cannot pass unnoticed.</div>
    </div>` : ""}

    <section>
      <h2>Where it stands</h2>
      <table class="sheet-table">
        <tbody>
          ${line("Form received", rec.submitted_at ? fmtDateTime(rec.submitted_at) : "Not received")}
          ${line("Code of Conduct agreed", rec.agreed_conduct_at
            ? fmtDateTime(rec.agreed_conduct_at) : "Not agreed")}
          ${line("Read by an administrator", rec.reviewed_at
            ? fmtDateTime(rec.reviewed_at) : "Not yet")}
          ${line("Payment received", rec.payment_received_at
            ? fmtDateTime(rec.payment_received_at) +
              (rec.payment_note ? ` — ${rec.payment_note}` : "")
            : "Not recorded")}
          ${line("Registered", rec.registered_at
            ? fmtDateTime(rec.registered_at) : "Not registered")}
          ${(rec.outstanding_at_registration ?? []).length
            ? line("Outstanding when registered", rec.outstanding_at_registration.join(", "))
            : ""}
        </tbody>
      </table>
    </section>

    ${s ? `<section>
      <h2>Children, as recorded on ${esc(fmtDate(s.taken_at))}</h2>
      ${(s.children ?? []).length ? `<table class="sheet-table bordered">
        <thead><tr>
          <th>Name</th><th>Date of birth</th><th class="num">Age at start</th>
          <th>Grade</th><th>Allergies</th><th>For a teacher to know</th>
        </tr></thead>
        <tbody>${(s.children ?? []).map((c) => `<tr>
          <td><strong>${esc(c.first_name)} ${esc(c.last_name ?? "")}</strong></td>
          <td class="mono">${esc(c.birth_date ?? "—")}</td>
          <td class="num mono">${c.age_at_start ?? "—"}</td>
          <td>${esc(c.grade ?? "—")}</td>
          <td>${esc(c.allergies ?? "—")}</td>
          <td>${esc(c.medical_notes ?? "—")}</td>
        </tr>`).join("")}</tbody>
      </table>` : `<p class="muted">No children were on file.</p>`}

      <h2 class="mt2">The family, as recorded</h2>
      <table class="sheet-table">
        <tbody>
          ${line("Email", s.family?.primary_email)}
          ${line("Phone", s.family?.primary_phone)}
          ${(s.parents ?? []).map((p) => line("Parent",
            `${p.first_name} ${p.last_name ?? ""}`.trim() +
            [p.email, p.phone].filter(Boolean).map((x) => ` · ${x}`).join(""))).join("")}
        </tbody>
      </table>
    </section>` : ""}

    <section>
      <h2>What they wrote</h2>
      <table class="sheet-table">
        <tbody>
          ${line("Phone given on the form", a.primary_phone)}
          ${line("Additional comments, including known absences", a.comments)}
        </tbody>
      </table>
      ${a.comments && !forPrint ? `<div class="note mt">
        If they have named dates here, record those absences yourself under
        <a href="#/absences">Absences</a> — nothing reads this text.</div>` : ""}
    </section>`;
}

function line(label, value) {
  return `<tr>
    <th class="sheet-label">${esc(label)}</th>
    <td>${value ? esc(String(value)) : `<span class="faint">—</span>`}</td>
  </tr>`;
}
