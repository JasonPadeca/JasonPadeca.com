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
  const [cls, roster] = await Promise.all([api.klass(id), api.classRoster(id)]);
  const period = cls.periods, semester = cls.semesters;
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

  render(app, `
    <div class="print-toolbar no-print">
      <a class="btn" href="#/classes/${esc(cls.id)}">← Back to class</a>
      <div class="spacer"></div>
      <span class="small muted">This sheet contains medical information. Hand it only to the teacher.</span>
      <button class="btn btn-primary" id="doprint">Print</button>
    </div>

    <div class="sheet">
      <header class="sheet-head">
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
    </div>`);

  $("#doprint")?.addEventListener("click", () => window.print());
}
