// =============================================================================
// Enrollment view (§35) — one searchable list of who is in what.
//
// The question this answers is the one that used to need a spreadsheet:
// "where is this child on Tuesday", "who has not registered yet", "which
// classes are full".
// =============================================================================

import { api } from "../../assets/api.js";
import { esc, $, render, toastErr, plural, debounce, downloadCSV } from "../../assets/ui.js";

export async function show(app) {
  const semesters = await api.semesters();
  if (!semesters.length) {
    return render(app, `<div class="wrap page"><div class="empty">
      <h3>No semesters yet</h3><p><a href="#/semesters">Create one</a> to see enrollment.</p>
    </div></div>`);
  }

  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const semesterId = params.get("s") ?? semesters[0].id;
  const semester = semesters.find((s) => s.id === semesterId) ?? semesters[0];

  const [regs, families, classes, sittingOut] = await Promise.all([
    api.semesterRegistrations(semester.id),
    api.families(),
    api.classes({ semester_id: semester.id }),
    api.sittingOut(semester.id).catch(() => new Set()),
  ]);

  // Every active child, with whatever they are registered for attached — so
  // children with nothing show up too, which is the whole point of the
  // "not yet registered" filter.
  const rows = [];
  for (const f of families) {
    for (const c of (f.children ?? []).filter((c) => c.active && !c.archived_at)) {
      const mine = regs.filter((r) => r.children?.id === c.id);
      rows.push({
        childId: c.id,
        child: `${c.first_name} ${c.last_name ?? ""}`.trim(),
        familyId: f.id,
        family: f.display_name,
        sittingOut: sittingOut.has(c.id),
        registrations: mine.sort((a, b) =>
          (a.classes?.periods?.period_number ?? 0) - (b.classes?.periods?.period_number ?? 0)),
      });
    }
  }
  rows.sort((a, b) => a.child.localeCompare(b.child));

  render(app, `<div class="wrap page">
    <div class="page-head">
      <div><h1>Enrollment</h1>
        <div class="sub">${esc(semester.name)} · ${plural(rows.length, "active child", "active children")}</div></div>
      <div class="btn-row">
        <button class="btn" id="csv">Export CSV</button>
      </div>
    </div>

    <div class="field-row mb">
      <div class="field" style="margin:0">
        <label for="sem">Semester</label>
        <select id="sem">${semesters.map((s) =>
          `<option value="${esc(s.id)}"${s.id === semester.id ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
      </div>
      <div class="field" style="margin:0">
        <label for="filter">Show</label>
        <select id="filter">
          <option value="all">Everyone</option>
          <option value="unregistered">Not yet registered</option>
          <option value="partial">Missing a period</option>
          <option value="waitlisted">On a waitlist</option>
          <option value="sittingout">Sitting this semester out</option>
        </select>
      </div>
      <div class="field" style="margin:0">
        <label for="cls">Class</label>
        <select id="cls">
          <option value="">Any class</option>
          ${classes.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")}
        </select>
      </div>
      <div class="field" style="margin:0">
        <label for="q">Search</label>
        <input type="search" id="q" placeholder="Child or family name…" autocomplete="off">
      </div>
    </div>

    <div id="results"></div>
  </div>`);

  const periodCount = new Set(classes.map((c) => c.period_id)).size;

  const draw = () => {
    const q = $("#q").value.trim().toLowerCase();
    const filter = $("#filter").value;
    const classId = $("#cls").value;

    let out = rows;

    if (q) out = out.filter((r) =>
      r.child.toLowerCase().includes(q) || r.family.toLowerCase().includes(q));

    if (classId) out = out.filter((r) => r.registrations.some((x) => x.class_id === classId));

    // "Not yet registered" and "missing a period" are both about chasing people.
    // Somebody who has said they are sitting out is not being chased.
    if (filter === "unregistered") {
      out = out.filter((r) => !r.sittingOut &&
        !r.registrations.some((x) => x.status === "registered"));
    } else if (filter === "partial") {
      out = out.filter((r) => !r.sittingOut &&
        r.registrations.filter((x) => x.status === "registered").length < periodCount);
    } else if (filter === "waitlisted") {
      out = out.filter((r) => r.registrations.some((x) => x.status === "waitlisted"));
    } else if (filter === "sittingout") {
      out = out.filter((r) => r.sittingOut);
    }

    if (!out.length) {
      return render("#results", `<div class="empty"><h3>Nothing matches</h3>
        <p>Try a different filter or search.</p></div>`);
    }

    render("#results", `<div class="table-scroll"><table>
      <thead><tr><th>Student</th><th>Family</th><th>Classes</th></tr></thead>
      <tbody>${out.map((r) => `<tr>
        <td><strong>${esc(r.child)}</strong></td>
        <td class="small"><a href="#/families/${esc(r.familyId)}">${esc(r.family)}</a></td>
        <td class="small">${r.registrations.length
          ? r.registrations.map((x) => `<div>
              <span class="faint mono">${esc(x.classes?.periods?.period_number ?? "?")}</span>
              <a href="#/classes/${esc(x.class_id)}">${esc(x.classes?.name ?? "")}</a>
              ${x.status === "waitlisted" ? `<span class="badge badge-warn">Waitlist</span>` : ""}
            </div>`).join("")
          : r.sittingOut
            ? `<span class="badge">Sitting out</span>`
            : `<span class="faint">Not registered</span>`}</td>
      </tr>`).join("")}</tbody></table></div>
      <p class="tiny faint mt">${plural(out.length, "student")} shown.</p>`);
  };

  draw();
  $("#q").addEventListener("input", debounce(draw, 200));
  $("#filter").addEventListener("change", draw);
  $("#cls").addEventListener("change", draw);
  $("#sem").addEventListener("change", (e) => { location.hash = `#/enrollment?s=${e.target.value}`; });

  $("#csv").addEventListener("click", () => {
    const data = [["Student", "Family", "Period", "Class", "Status"]];
    for (const r of rows) {
      if (!r.registrations.length) {
        data.push([r.child, r.family, "", "",
                   r.sittingOut ? "Sitting out" : "Not registered"]);
      }
      for (const x of r.registrations) {
        data.push([r.child, r.family,
          x.classes?.periods?.display_name ?? x.classes?.periods?.period_number ?? "",
          x.classes?.name ?? "", x.status]);
      }
    }
    downloadCSV(`${semester.name.replace(/\s+/g, "-").toLowerCase()}-enrollment.csv`, data);
  });
}
