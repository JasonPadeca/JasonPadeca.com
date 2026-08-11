// =============================================================================
// Volunteers — who offered to help, and where.
//
// Kept off the main working screens deliberately. This is reference material an
// administrator consults when they need to staff something, not a number they
// need in their face while building a semester.
// =============================================================================

import { api } from "../../assets/api.js";
import {
  esc, $, render, toastOk, toastErr, plural, downloadCSV, debounce,
  formDialog, confirmDialog, modal,
} from "../../assets/ui.js";
import { refresh } from "../app.js";

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

  const [report, periods, classes] = await Promise.all([
    api.volunteers(semester.id),
    api.periods(semester.id),
    api.classes({ semester_id: semester.id }),
  ]);
  const byPeriod = new Map(periods.map((p) => [p.id, p]));
  const placed = report.filter((r) => r.assignments?.length).length;

  render(app, `<div class="wrap page">
    <div class="page-head">
      <div><h1>Volunteers</h1>
        <div class="sub">${esc(semester.name)} ·
          ${plural(report.length, "person", "people")} offered ·
          ${placed} placed${report.length - placed > 0
            ? ` · <span style="color:var(--warn)">${report.length - placed} still unplaced</span>` : ""}</div></div>
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
          : "Families are asked when they sign up for classes. Offers appear here as they come in."}</p>
      </div>`);
    }

    render("#results", `<div class="table-scroll"><table>
      <thead><tr>
        <th>Who</th><th>Family</th><th>Offered for</th><th>Assigned to</th><th>Notes</th><th></th>
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
        <td class="small">${r.assignments?.length
          ? r.assignments.map((a) => `<div>
              <span class="faint mono">${esc(a.period_number)}</span>
              <a href="#/classes/${esc(a.class_id)}">${esc(a.class_name)}</a>
              <button class="btn btn-sm btn-ghost" data-unassign="${esc(a.id)}"
                      title="Remove from this class">×</button>
            </div>`).join("")
          : `<span class="badge badge-warn">Not placed</span>`}</td>
        <td class="small muted">${esc(r.note ?? "")}</td>
        <td class="right nowrap">
          <button class="btn btn-sm" data-assign="${esc(r.child_id)}">Assign</button></td>
      </tr>`).join("")}</tbody></table></div>
      <p class="tiny faint mt">${plural(rows.length, "offer")} shown.</p>`);

    document.querySelectorAll("[data-assign]").forEach((b) =>
      b.addEventListener("click", () =>
        assignFromOffer(report.find((r) => r.child_id === b.dataset.assign), classes, byPeriod)));

    document.querySelectorAll("[data-unassign]").forEach((b) =>
      b.addEventListener("click", async () => {
        const ok = await confirmDialog("Remove this assignment?",
          "They will no longer be listed as helping with that class. They are not put back into whatever they left to volunteer.",
          "Remove", true);
        if (!ok) return;
        try { await api.removeVolunteer(b.dataset.unassign); toastOk("Removed."); refresh(); }
        catch (e) { toastErr(e.message); }
      }));
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

/**
 * Place someone from their offer.
 *
 * The class list is ordered so the ones they actually asked for come first —
 * an administrator working down this page is trying to honour those requests,
 * and making them hunt through every class in the semester works against that.
 */
async function assignFromOffer(offer, classes, byPeriod) {
  if (!offer) return;

  const wanted = new Set(offer.slots.filter((s) => s.class_id).map((s) => s.class_id));
  const wantedPeriods = new Set(offer.slots.map((s) => s.period_id));

  const rank = (c) =>
    wanted.has(c.id) ? 0 : wantedPeriods.has(c.period_id) ? 1 : 2;

  const options = [...classes]
    .sort((a, b) =>
      rank(a) - rank(b) ||
      (byPeriod.get(a.period_id)?.period_number ?? 0) - (byPeriod.get(b.period_id)?.period_number ?? 0) ||
      a.name.localeCompare(b.name))
    .map((c) => {
      const p = byPeriod.get(c.period_id);
      const mark = wanted.has(c.id) ? "★ " : wantedPeriods.has(c.period_id) ? "· " : "  ";
      return {
        value: c.id,
        label: `${mark}${p?.display_name ?? "?"} — ${c.name}`,
      };
    });

  if (!options.length) return toastErr("This semester has no classes yet.");

  const v = await formDialog({
    title: `Where should ${offer.child_name} help?`,
    submitLabel: "Assign",
    fields: [
      { name: "class_id", label: "Class", type: "select", required: true, options,
        hint: "★ is a class they asked for; · is a period they offered." },
      { name: "note", label: "Note", value: offer.note ?? "",
        hint: "Optional. Shown on the class page and the printed roster." },
    ],
  });
  if (!v) return;

  const cls = classes.find((c) => c.id === v.class_id);
  let res;
  try { res = await api.assignVolunteer(offer.child_id, v.class_id, v.note, false); }
  catch (e) { return toastErr(e.message); }

  if (res?.needs_confirmation) {
    const ok = await modal({
      title: `Assign ${offer.child_name} to ${cls?.name ?? "this class"}?`,
      body: `${(res.warnings ?? []).map((w) =>
              `<div class="note note-warn">${esc(w.message)}</div>`).join("")}
             <p class="small mt">Volunteers do not take up a seat.</p>`,
      buttons: [
        { value: false, label: "Cancel" },
        { value: true, label: "Move them", class: "btn-danger" },
      ],
    });
    if (!ok) return;
    try { res = await api.assignVolunteer(offer.child_id, v.class_id, v.note, true); }
    catch (e) { return toastErr(e.message); }
  }

  toastOk(res?.withdrew_from
    ? `${offer.child_name} assigned, and withdrawn from ${res.withdrew_from}.`
    : `${offer.child_name} assigned to ${cls?.name ?? "the class"}.`);
  refresh();
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
