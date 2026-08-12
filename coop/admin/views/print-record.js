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
import { fieldsFor } from "../../assets/proposal-fields.js";

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
// One renderer, used by the printed sheet and by the dialog behind "Read it",
// because two renderers disagreed once already and the one people actually
// opened was the poorer of the two.
//
// It always lists everybody. Where a snapshot exists it shows that — the family
// as the co-op held it when it agreed to the registration. Where one does not,
// because the registration predates records being kept, it shows the family as
// it stands today and says so. "No snapshot" is a reason to label the source,
// not a reason to show an empty page.
// =============================================================================
export function recordBody(rec, { forPrint = false } = {}) {
  const snap = rec.snapshot;
  const shown = snap ?? rec.current;      // what we can actually show
  const asAt = !!snap;                    // ...and whether it is historical
  const a = rec.answers ?? {};
  const drift = rec.drift;

  const agreed = rec.agreed_conduct_at;

  return `
    ${Array.isArray(drift) && drift.length ? `<div class="sheet-alert">
      <strong>Details have changed since this was submitted.</strong>
      <ul>${drift.map((d) => `<li>${esc(d.child)}: ${esc(d.field)} was
        <strong>${esc(d.was ?? "blank")}</strong>, now
        <strong>${esc(d.now ?? "blank")}</strong></li>`).join("")}</ul>
      <div class="tiny">A correction is an ordinary reason for this. It is shown
        so it cannot pass unnoticed.</div>
    </div>` : ""}

    <div class="agreement ${agreed ? "yes" : "no"}">
      <strong>Code of Conduct:
        ${agreed ? "agreed" : "NOT AGREED"}</strong>
      ${agreed
        ? `<span class="muted">by this family on ${esc(fmtDateTime(agreed))}</span>`
        : `<span class="muted">no agreement is recorded against this
           registration</span>`}
    </div>

    <section>
      <h2>The family${asAt
        ? `, as recorded on ${esc(fmtDate(snap.taken_at))}`
        : " — as it stands today"}</h2>

      ${!asAt ? `<div class="sheet-note">
        This registration was submitted before records were kept, so there is no
        snapshot of what the co-op held at the time. Everything below is the
        family as it is <em>now</em>, which may not be what was agreed to.</div>` : ""}

      <h3>Parents</h3>
      ${(shown?.parents ?? []).length ? `<table class="sheet-table bordered">
        <thead><tr><th>Name</th><th>Email</th><th>Phone</th></tr></thead>
        <tbody>${shown.parents.map((p) => `<tr>
          <td><strong>${esc(p.first_name)} ${esc(p.last_name ?? "")}</strong></td>
          <td>${esc(p.email ?? "—")}</td>
          <td class="mono">${esc(p.phone ?? "—")}</td>
        </tr>`).join("")}</tbody>
      </table>` : `<p class="muted">Nobody on file.</p>`}

      <h3 class="mt2">Children</h3>
      ${(shown?.children ?? []).length ? `<table class="sheet-table bordered">
        <thead><tr>
          <th>Name</th><th>Date of birth</th>
          <th class="num">Age at ${esc(shown?.semester?.name ?? "start")}</th>
          <th>Grade</th><th>Allergies</th><th>For a teacher to know</th>
        </tr></thead>
        <tbody>${shown.children.map((c) => `<tr>
          <td><strong>${esc(c.first_name)} ${esc(c.last_name ?? "")}</strong></td>
          <td class="mono">${esc(c.birth_date ?? "—")}</td>
          <td class="num mono">${c.age_at_start ?? "—"}</td>
          <td>${esc(c.grade ?? "—")}</td>
          <td>${esc(c.allergies ?? "—")}</td>
          <td>${esc(c.medical_notes ?? "—")}</td>
        </tr>`).join("")}</tbody>
      </table>` : `<p class="muted">No children on file.</p>`}

      <table class="sheet-table mt2">
        <tbody>
          ${line("Family email", shown?.family?.primary_email)}
          ${line("Family phone", shown?.family?.primary_phone)}
        </tbody>
      </table>
    </section>

    <section>
      <h2>Where it stands</h2>
      <table class="sheet-table">
        <tbody>
          ${line("Form received", rec.submitted_at ? fmtDateTime(rec.submitted_at) : "Not received")}
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

// =============================================================================
// Class proposals, on paper.
//
// Two shapes, because two things happen with these.
//
// One proposal is read closely by somebody who has to decide whether the co-op
// can host it — every question, including the ones left blank, because "no, we
// do not need the printer" and "they did not get that far" are different
// answers and a summary that hides empties makes them look the same.
//
// A batch is what somebody carries into a meeting: all the proposals waiting,
// one per page, so they can be dealt out around a table. That is the actual
// use — these get discussed in a room, not clicked through.
// =============================================================================

/** Every question and answer for one proposal. */
function proposalBody(p) {
  return fieldsFor(p.kind).map((f) => {
    const v = p[f.name];
    return `<div class="qa">
      <div class="q">${esc(f.label)}</div>
      <div class="a">${v ? esc(v) : `<span class="faint">Left blank</span>`}</div>
    </div>`;
  }).join("");
}

function proposalHead(p, semesterName) {
  return `<header class="sheet-head">
    <div>
      <h1>${esc(p.title)}</h1>
      <div class="sheet-sub">
        ${p.kind === "student" ? "Proposed by a student" : "Proposed by a parent"}
        ${p.proposer ? ` · ${esc(p.proposer)}` : ""}
        · ages ${esc(p.age_range ?? "—")}
        · homework: ${esc((p.homework ?? "—").toLowerCase())}
      </div>
    </div>
    <div class="sheet-meta">
      <div>Koinonia Homeschool Group</div>
      <div>Class proposal${semesterName ? ` — ${esc(semesterName)}` : ""}</div>
      <div>Sent ${esc(fmtDate(p.submitted_at))}</div>
    </div>
  </header>`;
}

/** One proposal. */
export async function proposal(app, params) {
  let rows;
  try {
    rows = await api.proposals({ archived: false });
    if (!rows.some((r) => r.id === params.id)) {
      rows = rows.concat(await api.proposals({ archived: true }));
    }
  } catch (e) {
    return render(app, `<div class="wrap page">
      <div class="note note-danger">${esc(e.message)}</div></div>`);
  }

  const p = rows.find((r) => r.id === params.id);
  if (!p) {
    return render(app, `<div class="wrap page"><div class="empty">
      <h3>No such proposal</h3>
      <p><a href="#/proposals">Back to Proposals</a></p></div></div>`);
  }

  render(app, `
    <div class="sheet-actions no-print">
      <a class="btn" href="#/proposals">← Back</a>
      <button class="btn btn-primary" onclick="window.print()">Print</button>
    </div>

    <div class="sheet">
      ${proposalHead(p)}
      ${p.admin_notes ? `<div class="sheet-note"><strong>Note:</strong>
        ${esc(p.admin_notes)}</div>` : ""}
      <section>${proposalBody(p)}</section>
      <footer class="sheet-foot">
        Decisions about this proposal are made by the leadership in person.
        Nothing in this system approves or declines a class.
      </footer>
    </div>`);
}

/**
 * Every proposal still waiting, one per page.
 *
 * The handout for a planning meeting. Page breaks between them so a stack can
 * be split up and passed round rather than read off a screen by one person.
 */
export async function proposalsBatch(app) {
  let rows;
  try {
    rows = await api.proposals({ archived: false });
  } catch (e) {
    return render(app, `<div class="wrap page">
      <div class="note note-danger">${esc(e.message)}</div></div>`);
  }

  if (!rows.length) {
    return render(app, `<div class="wrap page"><div class="empty">
      <h3>Nothing waiting</h3>
      <p>There are no proposals to discuss.</p>
      <p><a href="#/proposals">Back to Proposals</a></p></div></div>`);
  }

  render(app, `
    <div class="sheet-actions no-print">
      <a class="btn" href="#/proposals">← Back</a>
      <button class="btn btn-primary" onclick="window.print()">
        Print all ${rows.length}</button>
    </div>

    <div class="sheet contents-sheet">
      <header class="sheet-head">
        <div>
          <h1>Class proposals to discuss</h1>
          <div class="sheet-sub">${rows.length} waiting${
            `, as at ${esc(PRINTED())}`}</div>
        </div>
        <div class="sheet-meta"><div>Koinonia Homeschool Group</div></div>
      </header>
      <table class="sheet-table bordered">
        <thead><tr><th>Class</th><th>From</th><th>Ages</th><th>Sent</th></tr></thead>
        <tbody>${rows.map((p) => `<tr>
          <td><strong>${esc(p.title)}</strong></td>
          <td>${esc(p.proposer ?? (p.kind === "student" ? "a student" : "a parent"))}</td>
          <td>${esc(p.age_range ?? "—")}</td>
          <td class="mono">${esc(fmtDate(p.submitted_at))}</td>
        </tr>`).join("")}</tbody>
      </table>
    </div>

    ${rows.map((p) => `<div class="sheet page-break">
      ${proposalHead(p)}
      <section>${proposalBody(p)}</section>
    </div>`).join("")}`);
}
