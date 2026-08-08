// =============================================================================
// Volunteers — who offered to help, and where.
//
// Kept off the main working screens deliberately. This is reference material an
// administrator consults when they need to staff something, not a number they
// need in their face while building a semester.
// =============================================================================

import { api } from "../../assets/api.js";
import { esc, $, render, toastErr, plural, downloadCSV, debounce } from "../../assets/ui.js";

export async function show(app) {
  const semesters = await api.semesters();
  if (!semesters.length) {
    return render(app, `<div class="wrap page"><div class="empty">
      <h3>No semesters yet</h3>
      <p>Volunteering is offered during registration, so there is nothing here until
         a semester exists.</p></div></div>`);
  }

  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const semesterId = params.get("s") ?? semesters[0].id;
  const semester = semesters.find((s) => s.id === semesterId) ?? semesters[0];

  const [report, periods] = await Promise.all([
    api.volunteers(semester.id),
    api.periods(semester.id),
  ]);

  render(app, `<div class="wrap page">
    <div class="page-head">
      <div><h1>Volunteers</h1>
        <div class="sub">${esc(semester.name)} ·
          ${plural(report.length, "family member", "family members")} offered to help</div></div>
      <div class="btn-row">
        <button class="btn" id="csv" ${report.length ? "" : "disabled"}>Export CSV</button>
      </div>
    </div>

    <div class="field-row mb">
      <div class="field" style="margin:0">
        <label for="sem">Semester</label>
        <select id="sem">${semesters.map((s) =>
          `<option value="${esc(s.id)}"${s.id === semester.id ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
      </div>
      <div class="field" style="margin:0">
        <label for="per">Period</label>
        <select id="per">
          <option value="">Any period</option>
          ${periods.map((p) => `<option value="${esc(p.id)}">${
            esc(p.display_name || `Period ${p.period_number}`)}</option>`).join("")}
        </select>
      </div>
      <div class="field" style="margin:0">
        <label for="q">Search</label>
        <input type="search" id="q" placeholder="Name, family, or class…" autocomplete="off">
      </div>
    </div>

    <div id="results"></div>
  </div>`);

  const draw = () => {
    const q = $("#q").value.trim().toLowerCase();
    const periodId = $("#per").value;

    let rows = report;
    if (periodId) {
      rows = rows.filter((r) => r.slots.some((s) => s.period_id === periodId));
    }
    if (q) {
      rows = rows.filter((r) =>
        r.child_name.toLowerCase().includes(q) ||
        r.family_name.toLowerCase().includes(q) ||
        (r.note ?? "").toLowerCase().includes(q) ||
        r.slots.some((s) => (s.class_name ?? "").toLowerCase().includes(q)));
    }

    if (!rows.length) {
      return render("#results", `<div class="empty">
        <h3>${report.length ? "Nothing matches" : "No offers yet"}</h3>
        <p>${report.length
          ? "Try a different period or search."
          : "Families are asked when they register. Offers appear here as they come in."}</p>
      </div>`);
    }

    render("#results", `<div class="table-scroll"><table>
      <thead><tr>
        <th>Who</th><th>Family</th><th>Offered for</th><th>Notes</th>
      </tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td><strong>${esc(r.child_name)}</strong>
          ${r.age != null ? `<div class="tiny faint">Age ${r.age}</div>` : ""}</td>
        <td class="small"><a href="#/families/${esc(r.family_id)}">${esc(r.family_name)}</a>
          ${r.family_email ? `<div class="tiny faint">${esc(r.family_email)}</div>` : ""}</td>
        <td class="small">${r.slots.length
          ? groupSlots(r.slots).map((g) => `<div>
              <strong>${esc(g.period_name)}</strong>${g.classes.length
                ? ` — ${g.classes.map((c) => esc(c)).join(", ")}`
                : ` <span class="faint">(any class)</span>`}
            </div>`).join("")
          : `<span class="faint">No preference</span>`}</td>
        <td class="small muted">${esc(r.note ?? "")}</td>
      </tr>`).join("")}</tbody></table></div>
      <p class="tiny faint mt">${plural(rows.length, "offer")} shown.</p>`);
  };

  draw();
  $("#q").addEventListener("input", debounce(draw, 200));
  $("#per").addEventListener("change", draw);
  $("#sem").addEventListener("change", (e) => { location.hash = `#/volunteers?s=${e.target.value}`; });

  $("#csv").addEventListener("click", () => {
    const data = [["Name", "Age", "Family", "Family email", "Period", "Class", "Notes"]];
    for (const r of report) {
      if (!r.slots.length) {
        data.push([r.child_name, r.age ?? "", r.family_name, r.family_email ?? "",
                   "", "Any", r.note ?? ""]);
      }
      for (const s of r.slots) {
        data.push([r.child_name, r.age ?? "", r.family_name, r.family_email ?? "",
                   s.period_name, s.class_name ?? "Any class", r.note ?? ""]);
      }
    }
    downloadCSV(`${semester.name.replace(/\s+/g, "-").toLowerCase()}-volunteers.csv`, data);
  });
}

/** Collapse a flat slot list into one line per period. */
function groupSlots(slots) {
  const byPeriod = new Map();
  for (const s of slots) {
    if (!byPeriod.has(s.period_id)) {
      byPeriod.set(s.period_id, {
        period_name: s.period_name, period_number: s.period_number, classes: [],
      });
    }
    if (s.class_name) byPeriod.get(s.period_id).classes.push(s.class_name);
  }
  return [...byPeriod.values()].sort((a, b) => a.period_number - b.period_number);
}
