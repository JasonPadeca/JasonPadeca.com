// =============================================================================
// The helper board.
//
// One rectangle per parent. Red until they are placed in enough classes, green
// once they are — the number comes from Settings rather than being baked in,
// because "two" is this co-op's answer this year and not a law.
//
// The colour is the whole point of the screen. Somebody allocating sixty
// parents across twenty classes is not reading; they are scanning for red. So
// the state has to be legible at arm's length and must not require counting.
//
// Beside it, every class with what it wants and what it has. Both halves come
// from ONE call, so they cannot disagree about a number — a board saying a
// parent is placed while the pane says the class is empty would be worse than
// either alone.
// =============================================================================

import { api } from "../../assets/api.js";
import {
  esc, $, $$, render, plural, toastOk, toastErr, formDialog,
} from "../../assets/ui.js";
import { refresh } from "../app.js";

export async function show(app) {
  let semesters = [];
  try {
    semesters = await api.semesters();
  } catch (e) {
    return render(app, `<div class="wrap page">
      <div class="note note-danger">${esc(e.message)}</div></div>`);
  }

  const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const semesterId = q.get("semester") ?? semesters[0]?.id;
  const semester = semesters.find((s) => s.id === semesterId);
  const filter = q.get("show") ?? "all";

  if (!semester) {
    return render(app, `<div class="wrap page"><div class="empty">
      <h3>No semesters yet</h3>
      <p>Create one under <a href="#/semesters">Semesters</a> first.</p>
    </div></div>`);
  }

  let board;
  try {
    board = await api.helperBoard(semester.id);
  } catch (e) {
    return render(app, `<div class="wrap page">
      <div class="note note-danger">${esc(e.message)}</div>
      <p class="muted mt">If this says the function does not exist, the database
      update that adds it has not been run yet.</p></div>`);
  }

  const target = board.target ?? 2;
  const parents = board.parents ?? [];
  const count = (p) => Object.keys(p.assigned ?? {}).length;
  const done = parents.filter((p) => count(p) >= target).length;
  const replied = parents.filter((p) => p.replied).length;

  const shown = filter === "unplaced" ? parents.filter((p) => count(p) < target)
    : filter === "silent" ? parents.filter((p) => !p.replied)
    : parents;

  render(app, `<div class="wrap page helper-page">
    <div class="page-head">
      <div>
        <h1>Class helpers</h1>
        <div class="sub">Placing parents in ${esc(semester.name)}</div>
      </div>
      ${semesters.length > 1 ? `<div class="btn-row">
        <select id="sem">${semesters.map((s) => `<option value="${esc(s.id)}"
          ${s.id === semester.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
      </div>` : ""}
    </div>

    <div class="stats">
      <div class="stat ${done < parents.length ? "attn" : ""}">
        <span class="n">${done}/${parents.length}</span>
        <div class="l">Parents placed</div></div>
      <div class="stat"><span class="n">${replied}</span>
        <div class="l">Replied to the email</div></div>
      <div class="stat"><span class="n">${target}</span>
        <div class="l">Classes each</div></div>
    </div>

    <div class="btn-row mt">
      ${[["all", `Everybody (${parents.length})`],
         ["unplaced", `Still to place (${parents.length - done})`],
         ["silent", `No reply (${parents.length - replied})`]]
        .map(([k, label]) => `<a class="btn btn-sm ${filter === k ? "btn-primary" : ""}"
          href="#/helpers?semester=${esc(semester.id)}&show=${k}">${esc(label)}</a>`).join("")}
      <div class="spacer"></div>
      <a class="btn btn-sm" href="#/helpers/email?semester=${esc(semester.id)}">Email parents…</a>
    </div>

    <div class="helper-layout mt">
      <div class="helper-board">
        ${shown.length ? shown.map((p) => rect(p, board, target)).join("")
          : `<div class="empty"><h3>Nobody here</h3>
             <p>No parents match this filter.</p></div>`}
      </div>

      <aside class="helper-ref">
        <h3>Classes this semester</h3>
        <p class="tiny muted">Helpers, and student places.</p>
        ${refPane(board.classes ?? [])}
      </aside>
    </div>
  </div>`);

  $("#sem", app)?.addEventListener("change", (e) => {
    location.hash = `#/helpers?semester=${e.target.value}`;
  });

  $$("[data-assign]", app).forEach((sel) =>
    sel.addEventListener("change", () => assign(sel, semester)));
}

// -----------------------------------------------------------------------------
// One parent
// -----------------------------------------------------------------------------
function rect(p, board, target) {
  const assigned = p.assigned ?? {};
  const n = Object.keys(assigned).length;
  const state = n >= target ? "is-done" : n > 0 ? "is-part" : "is-none";

  const wantedIn = new Set((p.wants ?? []).map((w) => String(w.class_id)));

  return `<div class="helper-rect ${state}" data-parent="${esc(p.id)}">
    <div class="hr-head">
      <div>
        <strong>${esc(p.name)}</strong>
        <div class="tiny muted">${esc(p.family)}${
          p.email ? ` · ${esc(p.email)}` : ""}</div>
      </div>
      <span class="hr-count">${n}/${target}</span>
    </div>

    ${p.replied
      ? ((p.wants ?? []).length
          ? `<div class="hr-wants">Offered:
              ${p.wants.map((w) => `<span class="chip-sm">${esc(w.class)}</span>`).join("")}</div>`
          : `<div class="hr-wants muted">Replied — not this semester.</div>`)
      : `<div class="hr-wants muted">No reply to the email yet.</div>`}

    ${p.note ? `<div class="hr-note">“${esc(p.note)}”</div>` : ""}

    <div class="hr-slots">
      ${(board.periods ?? []).map((per) => {
        const cur = assigned[per.id];
        return `<label class="hr-slot">
          <span class="tiny muted">${esc(per.name)}</span>
          <select data-assign data-parent="${esc(p.id)}" data-period="${esc(per.id)}">
            <option value="">—</option>
            ${per.classes.map((c) => `<option value="${esc(c.id)}"
              ${cur && cur.class_id === c.id ? "selected" : ""}>${
                esc(c.name)}${wantedIn.has(String(c.id)) ? " ★" : ""}</option>`).join("")}
          </select>
        </label>`;
      }).join("")}
    </div>
    <div class="tiny faint">★ marks a class they offered to take.</div>
  </div>`;
}

// -----------------------------------------------------------------------------
// The reference pane
// -----------------------------------------------------------------------------
function refPane(classes) {
  const byPeriod = {};
  for (const c of classes) (byPeriod[c.period] ??= []).push(c);

  return Object.entries(byPeriod).map(([period, list]) => `
    <div class="ref-period">
      <h4>${esc(period)}</h4>
      <table class="ref-table">
        <thead><tr><th>Class</th><th class="num">Helpers</th><th class="num">Students</th></tr></thead>
        <tbody>${list.map((c) => {
          const hFull = c.helpers_wanted > 0 && c.helpers_have >= c.helpers_wanted;
          const hNone = c.helpers_have === 0 && c.helpers_wanted > 0;
          const sFull = c.student_capacity != null && c.students_taken >= c.student_capacity;
          return `<tr>
            <td>${esc(c.name)}</td>
            <td class="num ${hFull ? "ok" : hNone ? "bad" : "warn"}">
              ${c.helpers_have}/${c.helpers_wanted}</td>
            <td class="num ${sFull ? "warn" : ""}">${c.students_taken}/${
              c.student_capacity ?? "∞"}</td>
          </tr>`;
        }).join("")}</tbody>
      </table>
    </div>`).join("");
}

async function assign(sel, semester) {
  const parentId = sel.dataset.parent;
  const periodId = sel.dataset.period;
  const classId = sel.value;

  try {
    const res = classId
      ? await api.assignAdultHelper(parentId, classId)
      : await api.removeAdultHelper(parentId, periodId);

    if (!res?.ok) {
      if (res?.error === "class_full") {
        toastErr(`That class already has its ${plural(res.wanted, "helper")}. ` +
                 "Raise its limit on the class page, or choose another.");
      } else {
        toastErr("Could not place them there.");
      }
      return refresh();   // put the dropdown back to the truth
    }
    toastOk(classId ? "Placed." : "Removed.");
    await refresh();
  } catch (e) {
    toastErr(e.message);
    await refresh();
  }
}
