// =============================================================================
// Absences, as an administrator sees them.
//
// Grouped by day rather than listed flat, because the question is almost always
// "who is out this Thursday" and never "show me every absence this term". The
// day a parent reports for is the unit of use.
//
// Each row carries the classes that child would otherwise be in, with the
// teacher's name, since the point of collecting this at all is that the person
// holding the register finds out.
// =============================================================================

import { api } from "../../assets/api.js";
import {
  esc, $, render, fmtDate, toastOk, toastErr, plural, downloadCSV, debounce,
  formDialog,
} from "../../assets/ui.js";

export async function show(app) {
  const semesters = await api.semesters();
  if (!semesters.length) {
    return render(app, `<div class="wrap page">
      <div class="page-head"><div><h1>Absences</h1></div></div>
      <div class="empty"><h3>No semesters yet</h3>
        <p>Absences are reported against a semester's class days.</p></div>
    </div>`);
  }

  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const semesterId = params.get("semester") ?? semesters[0].id;
  const showPast = params.get("past") === "1";

  render(app, `<div class="wrap page">
    <div class="page-head">
      <div><h1>Absences</h1><div class="sub" id="sub">Loading…</div></div>
      <div class="btn-row">
        <a class="btn" href="#/absences?semester=${esc(semesterId)}${showPast ? "" : "&past=1"}">
          ${showPast ? "Upcoming only" : "Include past"}</a>
        <button class="btn btn-primary" id="add">Record an absence</button>
        <button class="btn" id="export">Export CSV</button>
      </div>
    </div>

    <div class="grid grid-2">
      <div class="field">
        <label for="sem">Semester</label>
        <select id="sem">${semesters.map((s) =>
          `<option value="${esc(s.id)}" ${s.id === semesterId ? "selected" : ""}>
            ${esc(s.name)}</option>`).join("")}</select>
      </div>
      <div class="field">
        <label for="search">Search</label>
        <input type="search" id="search" placeholder="Child, family, or reason…" autocomplete="off">
      </div>
    </div>

    <div id="results"><div class="loading"><span class="spinner"></span> Loading…</div></div>
  </div>`);

  $("#sem").addEventListener("change", (e) => {
    location.hash = `#/absences?semester=${e.target.value}${showPast ? "&past=1" : ""}`;
  });

  const from = showPast ? null : todayISO();
  let rows = [];
  try {
    rows = await api.absenceReport(semesterId, from);
  } catch (e) {
    return render("#results", `<div class="note note-danger">${esc(e.message)}</div>`);
  }

  const draw = (term = "") => {
    const t = term.trim().toLowerCase();
    const matched = !t ? rows : rows.filter((r) =>
      r.child_name?.toLowerCase().includes(t) ||
      r.family_name?.toLowerCase().includes(t) ||
      r.reason?.toLowerCase().includes(t));

    render("#sub", `${esc(semesters.find((s) => s.id === semesterId)?.name ?? "")} ·
      ${plural(matched.length, "absence")}${showPast ? "" : " still to come"}`);

    if (!matched.length) {
      return render("#results", `<div class="empty">
        <h3>${t ? "No matches" : "Nothing reported"}</h3>
        <p>${t ? "Try a different search."
              : showPast ? "No absences have been reported for this semester."
                         : "No absences reported for any day still to come."}</p>
      </div>`);
    }

    // One card per day. Families report per day, and administrators read per day.
    const byDate = new Map();
    for (const r of matched) {
      if (!byDate.has(r.date)) byDate.set(r.date, []);
      byDate.get(r.date).push(r);
    }

    render("#results", [...byDate.entries()].map(([date, list]) => `
      <div class="card">
        <div class="card-head">
          <h3>${esc(fmtDate(date))}</h3>
          <span class="badge">${plural(list.length, "child", "children")} away</span>
        </div>
        <div class="table-scroll"><table>
          <thead><tr>
            <th>Who</th><th>Missing</th><th>Classes affected</th><th>Reason</th><th></th>
          </tr></thead>
          <tbody>${list.map((r) => `<tr>
            <td><strong>${esc(r.child_name)}</strong>
              <div class="tiny faint"><a href="#/families/${esc(r.family_id)}">${
                esc(r.family_name)}</a>${
                r.family_phone ? ` · <span class="mono">${esc(r.family_phone)}</span>` : ""}</div></td>
            <td class="small">${r.whole_day
              ? `<strong>The whole day</strong>`
              : (r.periods ?? []).map((p) => esc(p.name)).join(", ") || "<span class='faint'>—</span>"}</td>
            <td class="small">${(r.classes ?? []).length
              ? (r.classes ?? []).map((c) => `<div>${esc(c.class_name)}${
                  c.teacher_name ? ` <span class="faint">· ${esc(c.teacher_name)}</span>` : ""}</div>`).join("")
              : `<span class="faint">Not enrolled in anything then</span>`}</td>
            <td class="small muted">${esc(r.reason ?? "")}
              ${r.reported_by === "admin"
                ? `<div class="tiny faint">Entered by an administrator</div>` : ""}</td>
            <td class="right nowrap">
              <button class="btn btn-sm btn-ghost" data-remove="${esc(r.id)}">Remove</button></td>
          </tr>`).join("")}</tbody>
        </table></div>
      </div>`).join(""));

    document.querySelectorAll("[data-remove]").forEach((b) =>
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          await api.cancelAbsence(b.dataset.remove);
          toastOk("Removed.");
          rows = rows.filter((r) => r.id !== b.dataset.remove);
          draw($("#search").value);
        } catch (e) {
          toastErr(e.message);
          b.disabled = false;
        }
      }));
  };

  draw();
  $("#search").addEventListener("input", debounce((e) => draw(e.target.value)));

  $("#add").addEventListener("click", () => recordOne(semesterId));

  $("#export").addEventListener("click", () => {
    const out = [["Date", "Child", "Family", "Phone", "Missing", "Classes affected", "Reason", "Reported by"]];
    for (const r of rows) {
      out.push([
        r.date, r.child_name, r.family_name, r.family_phone ?? "",
        r.whole_day ? "Whole day" : (r.periods ?? []).map((p) => p.name).join("; "),
        (r.classes ?? []).map((c) => c.class_name).join("; "),
        r.reason ?? "", r.reported_by,
      ]);
    }
    downloadCSV(`absences-${new Date().toISOString().slice(0, 10)}.csv`, out);
    toastOk("Downloaded.");
  });
}

/** Today in local time. UTC would be yesterday for most of the evening here. */
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}


/**
 * An administrator recording an absence a family told them about.
 *
 * This screen was a report with no way to add anything, which made the agreed
 * process — a family writes "we are away on the 12th" in their registration
 * form, and somebody records it — impossible to actually carry out. The
 * database has always allowed it: report_absence lets an administrator act for
 * any child. There was simply no button.
 */
async function recordOne(semesterId) {
  let families = [], meetings = [], periods = [];
  try {
    [families, meetings, periods] = await Promise.all([
      api.families(),
      api.meetings(semesterId),
      api.periods(semesterId),
    ]);
  } catch (e) {
    return toastErr(e.message);
  }

  // families() already embeds its children, so this needs no endpoint of its own.
  const children = families.flatMap((f) =>
    (f.children ?? [])
      .filter((c) => c.active && !c.archived_at)
      .map((c) => ({ ...c, family_name: f.display_name })))
    .sort((a, b) => (a.family_name + a.first_name).localeCompare(b.family_name + b.first_name));

  if (!children.length) return toastErr("There are no children on file yet.");

  const upcoming = meetings.filter((m) => !m.cancelled);
  if (!upcoming.length) {
    return toastErr("This semester has no class dates set up yet.");
  }

  const answers = await formDialog({
    title: "Record an absence",
    submitLabel: "Record it",
    fields: [
      { name: "child_id", label: "Child", type: "select", required: true,
        options: children.map((c) => ({
          value: c.id,
          label: `${c.first_name} ${c.last_name ?? ""} — ${c.family_name ?? ""}`.trim(),
        })) },
      { name: "meets_on", label: "Date", type: "select", required: true,
        options: upcoming.map((m) => ({ value: m.meets_on, label: fmtDate(m.meets_on) })) },
      { name: "scope", label: "How much of the day?", type: "select", value: "whole",
        options: [
          { value: "whole", label: "The whole day" },
          ...periods.map((p) => ({ value: p.id, label: `Only ${p.name}` })),
        ] },
      { name: "reason", label: "Reason", type: "textarea",
        hint: "Optional. Teachers see this." },
    ],
  });
  if (!answers) return;

  try {
    const whole = answers.scope === "whole";
    await api.reportAbsence(
      answers.child_id, answers.meets_on, whole,
      whole ? [] : [answers.scope], answers.reason);
    toastOk("Absence recorded.");
    // Re-enter the view so the new row appears in the report below.
    await show(document.getElementById("app"));
  } catch (e) {
    toastErr(e.message);
  }
}
