// =============================================================================
// Printable class roster.
//
// A separate view rather than print styles bolted onto the admin page, because
// the two want different things. On screen an administrator wants controls and
// links; on paper a teacher wants names, ages, who to call, and what would
// constitute an emergency — laid out to be read at a glance while holding a
// clipboard.
//
// The sheet is deliberately plain: black on white, no colour to survive a
// photocopier, and a signature column, because a paper roster in a co-op ends
// up being the attendance sheet whatever anyone intended.
// =============================================================================

import { api } from "../../assets/api.js";
import {
  esc, $, render, fmtDate, fmtTimeRange, eligibilityLabel,
  ageAt, familyPhone, familyEmail, plural,
} from "../../assets/ui.js";

export async function show(app, { id }) {
  const [cls, roster, helpers] = await Promise.all([
    api.klass(id), api.classRoster(id), api.classVolunteers(id).catch(() => []),
  ]);

  render(app, `
    <div class="print-toolbar no-print">
      <a class="btn" href="#/classes/${esc(cls.id)}">← Back to class</a>
      <div class="spacer"></div>
      <span class="small muted">This sheet contains medical information. Hand it only to the teacher.</span>
      <button class="btn btn-primary" id="doprint">Print</button>
    </div>
    ${sheet(cls, roster, cls.periods, cls.semesters, false, helpers)}`);

  $("#doprint")?.addEventListener("click", () => window.print());
}

/**
 * Every roster in a semester, one class per page.
 *
 * The point is a single trip to the printer at the start of term rather than
 * opening each class in turn — and, on the screen before that, one place to see
 * that every class has a teacher and a room.
 */
export async function all(app, { id }) {
  render(app, `<div class="loading"><span class="spinner"></span> Gathering rosters…</div>`);

  const [semester, classes] = await Promise.all([api.semester(id), api.classes({ semester_id: id })]);
  const periods = await api.periods(id);
  const byPeriod = new Map(periods.map((p) => [p.id, p]));

  // Sequential rather than parallel: a semester can hold a couple of dozen
  // classes, and firing that many roster queries at once is a poor way to treat
  // a database on a free plan.
  const rosters = [];
  for (const c of classes) {
    rosters.push([c, await api.classRoster(c.id),
                  await api.classVolunteers(c.id).catch(() => [])]);
  }

  rosters.sort(([a], [b]) =>
    ((byPeriod.get(a.period_id)?.period_number ?? 0) - (byPeriod.get(b.period_id)?.period_number ?? 0)) ||
    (a.option_number ?? 0) - (b.option_number ?? 0) ||
    a.name.localeCompare(b.name));

  const totalSeats = rosters.reduce((n, [, r]) =>
    n + r.filter((x) => x.status === "registered").length, 0);
  const missing = rosters.filter(([c]) => !c.teacher_name?.trim() || !c.location?.trim());

  render(app, `
    <div class="print-toolbar no-print">
      <a class="btn" href="#/semesters/${esc(semester.id)}">← Back to semester</a>
      <div class="spacer"></div>
      <span class="small muted">${plural(rosters.length, "roster")} ·
        ${plural(totalSeats, "seat")} · one class per page</span>
      <button class="btn btn-primary" id="doprint">Print all</button>
    </div>

    ${missing.length ? `<div class="no-print" style="max-width:7.9in;margin:1rem auto 0;padding:0 1.25rem">
      <div class="note note-warn">
        <strong>${plural(missing.length, "class", "classes")} missing a teacher or a room.</strong>
        Those lines will print blank:
        <ul>${missing.map(([c]) => `<li>${esc(c.name)} —
          ${!c.teacher_name?.trim() ? "no teacher" : ""}${
            !c.teacher_name?.trim() && !c.location?.trim() ? ", " : ""}${
            !c.location?.trim() ? "no location" : ""}</li>`).join("")}</ul>
      </div>
    </div>` : ""}

    ${rosters.length
      ? rosters.map(([c, roster, helpers], i) =>
          sheet(c, roster, byPeriod.get(c.period_id), semester, i > 0, helpers)).join("")
      : `<div class="sheet"><p class="empty-print">This semester has no classes yet.</p></div>`}`);

  $("#doprint")?.addEventListener("click", () => window.print());
}

/** One roster sheet. `pageBreak` starts it on a fresh sheet of paper. */
function sheet(cls, roster, period, semester, pageBreak = false, helpers = []) {
  const refDate = semester?.class_start_date;

  const registered = roster
    .filter((r) => r.status === "registered")
    .sort((a, b) => {
      const an = `${a.children?.last_name ?? ""} ${a.children?.first_name ?? ""}`;
      const bn = `${b.children?.last_name ?? ""} ${b.children?.first_name ?? ""}`;
      return an.localeCompare(bn);
    });

  const waitlisted = roster
    .filter((r) => r.status === "waitlisted")
    .sort((a, b) => (a.waitlisted_at ?? "").localeCompare(b.waitlisted_at ?? ""));

  // Anything a teacher might have to act on, gathered where it cannot be missed.
  const flagged = registered.filter((r) => r.children?.allergies || r.children?.medical_notes);

  return `
    <div class="sheet${pageBreak ? " page-break" : ""}">
      <header class="sheet-head">
        <div class="sheet-title">
          <img src="../assets/koinonia-logo.jpg" alt="" class="sheet-mark"
               width="44" height="44">
          <div>
          <h1>${esc(cls.name)}</h1>
          <div class="sheet-meta">
            <span><strong>Teacher</strong> ${esc(cls.teacher_name || "—")}</span>
            <span><strong>Where</strong> ${esc(cls.location || "—")}</span>
            <span><strong>When</strong> ${esc(period?.display_name || "")}
              ${esc(fmtTimeRange(period?.start_time, period?.end_time))}</span>
          </div>
          <div class="sheet-meta">
            <span><strong>Semester</strong> ${esc(semester?.name ?? "")}</span>
            ${semester?.class_start_date
              ? `<span><strong>Term</strong> ${esc(fmtDate(semester.class_start_date))} – ${esc(fmtDate(semester.class_end_date))}</span>`
              : ""}
            ${eligibilityLabel(cls) ? `<span><strong>Eligibility</strong> ${esc(eligibilityLabel(cls))}</span>` : ""}
          </div>
          </div>
        </div>
        <div class="sheet-count">
          <span class="n">${registered.length}</span>
          <span class="l">${plural(registered.length, "student")}</span>
        </div>
      </header>

      ${flagged.length ? `<section class="alerts">
        <h2>Allergies &amp; medical</h2>
        ${flagged.map((r) => `<div class="alert-row">
          <strong>${esc(r.children.first_name)} ${esc(r.children.last_name ?? "")}</strong>
          ${r.children.allergies ? `<span class="tag">Allergy</span> ${esc(r.children.allergies)}` : ""}
          ${r.children.allergies && r.children.medical_notes ? " · " : ""}
          ${r.children.medical_notes ? `<span class="tag">Medical</span> ${esc(r.children.medical_notes)}` : ""}
        </div>`).join("")}
      </section>` : ""}

      ${registered.length ? `<table class="sheet-table">
        <thead><tr>
          <th style="width:1.6rem">#</th>
          <th>Student</th>
          <th style="width:2.4rem">Age</th>
          <th>Student contact</th>
          <th>Parent contact</th>
          <th>Allergies / medical</th>
          <th style="width:5.5rem">Present</th>
        </tr></thead>
        <tbody>${registered.map((r, i) => {
          const ch = r.children ?? {};
          const fam = ch.families ?? {};
          const care = [ch.allergies, ch.medical_notes].filter(Boolean).join(" · ");
          const pPhone = familyPhone(fam), pEmail = familyEmail(fam);
          return `<tr>
            <td class="num">${i + 1}</td>
            <td><strong>${esc(ch.first_name)} ${esc(ch.last_name ?? "")}</strong></td>
            <td class="num">${ageAt(ch.birth_date, refDate) ?? "—"}</td>
            <td>
              ${ch.phone ? `<div class="mono">${esc(ch.phone)}</div>` : ""}
              ${ch.email ? `<div class="sub">${esc(ch.email)}</div>` : ""}
              ${!ch.phone && !ch.email ? `<span class="sub">—</span>` : ""}</td>
            <td>${esc(fam.display_name ?? "")}
              ${pPhone ? `<div class="mono">${esc(pPhone)}</div>` : ""}
              ${pEmail ? `<div class="sub">${esc(pEmail)}</div>` : ""}</td>
            <td>${care ? esc(care) : ""}</td>
            <td></td>
          </tr>`;
        }).join("")}</tbody>
      </table>` : `<p class="empty-print">No students enrolled.</p>`}

      ${helpers.length ? `<section class="helpers-print">
        <h2>Volunteers</h2>
        <p class="helpers-note">Helping with this class. They are not students here
          and do not use a seat.</p>
        <table class="sheet-table">
          <tbody>${helpers.map((v) => {
            const ch = v.children ?? {};
            const fam = ch.families ?? {};
            const phone = ch.phone || familyPhone(fam);
            return `<tr>
              <td><strong>${esc(ch.first_name)} ${esc(ch.last_name ?? "")}</strong>
                <div class="sub">${esc(fam.display_name ?? "")}</div></td>
              <td class="num">${ageAt(ch.birth_date, refDate) ?? "—"}</td>
              <td>${phone ? `<span class="mono">${esc(phone)}</span>` : ""}</td>
              <td>${esc(v.note ?? "")}</td>
            </tr>`;
          }).join("")}</tbody>
        </table>
      </section>` : ""}

      ${waitlisted.length ? `<section class="waitlist-print">
        <h2>Waitlist</h2>
        <ol>${waitlisted.map((r) => `<li>${esc(r.children?.first_name ?? "")}
          ${esc(r.children?.last_name ?? "")}
          <span class="sub">${esc(r.children?.families?.display_name ?? "")}</span></li>`).join("")}</ol>
      </section>` : ""}

      <footer class="sheet-foot">
        Printed ${esc(new Date().toLocaleDateString("en-US",
          { year: "numeric", month: "long", day: "numeric" }))}
        · Contains medical information about children — do not leave unattended.
      </footer>
    </div>`;
}
