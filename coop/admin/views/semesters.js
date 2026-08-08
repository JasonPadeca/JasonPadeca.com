// =============================================================================
// Semester builder (§10–§14, §22, §23).
//
// The hierarchy an administrator actually thinks in:
//   Semester › Period › Class › Students
// with breadcrumbs at every level so it is always obvious where you are (§38).
// =============================================================================

import { api } from "../../assets/api.js";
import {
  esc, $, render, fmtDate, fmtTimeRange, eligibilityLabel, ageAt, familyPhone,
  toastOk, toastErr, plural, formDialog, confirmDialog, modal,
} from "../../assets/ui.js";
import { refresh, go } from "../app.js";
import { statusBadge } from "./dashboard.js";

// =============================================================================
// Semester list (§10)
// =============================================================================
export async function list(app) {
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const showArchived = params.get("archived") === "1";

  const all = await api.semesters({ includeArchived: true });
  const semesters = all.filter((s) => showArchived ? s.archived_at : !s.archived_at);

  render(app, `<div class="wrap page">
    <div class="page-head">
      <div><h1>${showArchived ? "Archived Semesters" : "Semesters"}</h1></div>
      <div class="btn-row">
        <a class="btn" href="#/semesters${showArchived ? "" : "?archived=1"}">
          ${showArchived ? "View Current" : "View Archived"}</a>
        ${showArchived ? "" : `<button class="btn btn-primary" id="add">+ Add Semester</button>`}
      </div>
    </div>

    ${semesters.length ? semesters.map((s) => `
      <a class="card card-link" href="#/semesters/${esc(s.id)}">
        <div class="card-head" style="margin:0">
          <div>
            <h3>${esc(s.name)}</h3>
            <div class="small muted">${s.class_start_date
              ? `${esc(fmtDate(s.class_start_date))} – ${esc(fmtDate(s.class_end_date))}`
              : "<em>No dates set</em>"}</div>
          </div>
          ${statusBadge(s)}
        </div>
      </a>`).join("")
    : `<div class="empty"><h3>No ${showArchived ? "archived " : ""}semesters</h3>
        <p>${showArchived ? "" : "Create a semester, then add its periods and classes."}</p></div>`}
  </div>`);

  $("#add")?.addEventListener("click", () => semesterDialog());
}

async function semesterDialog(existing = null) {
  const v = await formDialog({
    title: existing ? "Edit Semester" : "Add Semester",
    submitLabel: existing ? "Save" : "Create Semester",
    fields: [
      { name: "name", label: "Semester name", value: existing?.name, required: true,
        placeholder: "Fall 2027" },
      { name: "description", label: "Description", type: "textarea", value: existing?.description },
      { name: "class_start_date", label: "First class date", type: "date",
        value: existing?.class_start_date,
        hint: "Ages are calculated as of this date, so eligibility depends on it." },
      { name: "class_end_date", label: "Last class date", type: "date", value: existing?.class_end_date },
      { name: "registration_close_at", label: "Registration closes", type: "datetime-local",
        value: existing?.registration_close_at ? existing.registration_close_at.slice(0, 16) : null,
        hint: "Family registration links stop working after this." },
    ],
  });
  if (!v) return;

  try {
    if (existing) {
      await api.updateSemester(existing.id, v);
      toastOk("Saved.");
      refresh();
    } else {
      const s = await api.createSemester(v);
      toastOk(`${s.name} created.`);
      go(`#/semesters/${s.id}`);
    }
  } catch (e) { toastErr(e.message); }
}

// =============================================================================
// Semester detail — the period cards (§11)
// =============================================================================
export async function detail(app, { id }) {
  const [semester, periods, classes, invites] = await Promise.all([
    api.semester(id),
    api.periods(id),
    api.classes({ semester_id: id }),
    api.invites(id).catch(() => []),
  ]);

  const byPeriod = new Map();
  for (const c of classes) {
    if (!byPeriod.has(c.period_id)) byPeriod.set(c.period_id, []);
    byPeriod.get(c.period_id).push(c);
  }

  const failed = invites.filter((i) => i.send_error);

  render(app, `<div class="wrap page">
    <div class="crumbs"><a href="#/semesters">Semesters</a><span>›</span>${esc(semester.name)}</div>

    <div class="page-head">
      <div>
        <h1>${esc(semester.name)}</h1>
        <div class="sub">${statusBadge(semester)}
          ${semester.class_start_date
            ? ` · ${esc(fmtDate(semester.class_start_date))} – ${esc(fmtDate(semester.class_end_date))}` : ""}</div>
      </div>
      <div class="btn-row">
        <button class="btn" id="editsem">Edit</button>
        ${semester.status === "registration_open"
          ? `<button class="btn" id="closereg">Close Registration</button>`
          : `<button class="btn btn-primary" id="openreg">Open Registration</button>`}
      </div>
    </div>

    ${failed.length ? `<div class="note note-danger">
      <strong>${plural(failed.length, "invitation")} could not be delivered.</strong>
      Fix the family's email address, then use Resend below.
    </div>` : ""}

    ${semester.status === "registration_open" ? `<div class="card">
      <div class="card-head"><h3>Registration Invitations</h3>
        <span class="small muted">${invites.filter((i) => i.sent_at).length} sent</span></div>
      <div id="inviteList"></div>
    </div>` : ""}

    <div class="card-head mt2"><h2>Periods</h2>
      <button class="btn btn-sm" id="addperiod">+ Add Period</button></div>

    ${periods.length ? periods.map((p) => {
      const cs = byPeriod.get(p.id) ?? [];
      return `<div class="card period-card">
        <div class="card-head">
          <div>
            <h3><a href="#/periods/${esc(p.id)}">${esc(p.display_name || `Period ${p.period_number}`)}</a></h3>
            <div class="period-time">${esc(fmtTimeRange(p.start_time, p.end_time))}
              · ${plural(cs.length, "class", "classes")}</div>
          </div>
          <div class="btn-row">
            <button class="btn btn-sm btn-ghost" data-editperiod="${esc(p.id)}">Edit</button>
            <a class="btn btn-sm" href="#/periods/${esc(p.id)}">Open</a>
          </div>
        </div>
        ${cs.length ? `<div class="class-list">${cs.map(classRow).join("")}</div>`
          : `<p class="muted small">No classes in this period yet.</p>`}
      </div>`;
    }).join("")
    : `<div class="empty"><h3>No periods yet</h3>
        <p>Add the scheduling blocks for this semester — most co-ops use three.</p></div>`}

    <div class="btn-row mt2">
      <button class="btn btn-danger" id="archivesem">
        ${semester.archived_at ? "Restore Semester" : "Archive Semester"}</button>
    </div>
  </div>`);

  if (semester.status === "registration_open") await drawInvites(semester, invites);

  $("#editsem").addEventListener("click", () => semesterDialog(semester));
  $("#addperiod").addEventListener("click", () => periodDialog(semester.id, null, periods));

  app.querySelectorAll("[data-editperiod]").forEach((b) =>
    b.addEventListener("click", () =>
      periodDialog(semester.id, periods.find((p) => p.id === b.dataset.editperiod), periods)));

  $("#openreg")?.addEventListener("click", () => openRegistration(semester));

  $("#closereg")?.addEventListener("click", async () => {
    const ok = await confirmDialog("Close registration?",
      "Families will no longer be able to register or change their choices. You can reopen it later.",
      "Close Registration");
    if (!ok) return;
    try {
      await api.updateSemester(semester.id, { status: "registration_closed" });
      toastOk("Registration closed."); refresh();
    } catch (e) { toastErr(e.message); }
  });

  $("#archivesem").addEventListener("click", async () => {
    const archiving = !semester.archived_at;
    const ok = await confirmDialog(
      archiving ? "Archive semester?" : "Restore semester?",
      archiving
        ? "The semester disappears from current screens. Every registration, roster, and waitlist is kept and stays viewable in the archive."
        : "The semester will appear in the current list again.",
      archiving ? "Archive" : "Restore", archiving);
    if (!ok) return;
    try {
      await api.updateSemester(semester.id, {
        archived_at: archiving ? new Date().toISOString() : null,
        status: archiving ? "archived" : "registration_closed",
      });
      toastOk(archiving ? "Archived." : "Restored.");
      go("#/semesters");
    } catch (e) { toastErr(e.message); }
  });
}

function classRow(c) {
  const s = c.seats ?? {};
  const over = s.capacity != null && s.registered_count > s.capacity;
  const pct = s.capacity ? Math.min(100, (s.registered_count / s.capacity) * 100) : 0;
  const elig = eligibilityLabel(c);
  return `<a class="class-row ${c.archived_at ? "archived" : ""}" href="#/classes/${esc(c.id)}">
    <span class="cr-main">
      <span class="cr-name">${esc(c.name)}${c.archived_at ? ` <span class="badge">Cancelled</span>` : ""}</span>
      <span class="cr-meta">${[elig, c.teacher_name].filter(Boolean).map(esc).join(" · ") || "&nbsp;"}</span>
    </span>
    <span class="cr-seats">
      ${s.capacity == null ? `${s.registered_count ?? 0} enrolled`
        : `${s.registered_count ?? 0} / ${s.capacity}`}
      ${over ? `<div class="tiny" style="color:var(--danger)">over capacity</div>`
        : s.is_full ? `<div class="tiny" style="color:var(--warn)">FULL${
            s.waitlisted_count ? ` · ${s.waitlisted_count} waiting` : ""}</div>`
        : s.capacity != null ? `<div class="tiny faint">${plural(s.seats_open, "seat")} open</div>` : ""}
      ${s.capacity != null
        ? `<span class="seatbar ${over ? "over" : s.is_full ? "full" : ""}"><i style="width:${pct}%"></i></span>` : ""}
    </span>
  </a>`;
}

async function periodDialog(semesterId, existing, allPeriods) {
  const nextNumber = Math.max(0, ...allPeriods.map((p) => p.period_number)) + 1;
  const v = await formDialog({
    title: existing ? "Edit Period" : "Add Period",
    fields: [
      { name: "period_number", label: "Period number", type: "number", min: 1,
        value: existing?.period_number ?? nextNumber, required: true },
      { name: "display_name", label: "Name shown to families",
        value: existing?.display_name, placeholder: `First Hour` },
      { name: "start_time", label: "Start time", type: "time", value: existing?.start_time?.slice(0, 5) },
      { name: "end_time", label: "End time", type: "time", value: existing?.end_time?.slice(0, 5) },
    ],
  });
  if (!v) return;
  try {
    if (existing) await api.updatePeriod(existing.id, v);
    else await api.createPeriod({ ...v, semester_id: semesterId, sort_order: v.period_number });
    toastOk("Saved.");
    refresh();
  } catch (e) { toastErr(e.message); }
}

// -----------------------------------------------------------------------------
// Opening registration (§23, §39)
// -----------------------------------------------------------------------------
async function openRegistration(semester) {
  let pf;
  try { pf = await api.preflight(semester.id); }
  catch (e) { return toastErr(e.message); }

  const warnings = pf.warnings ?? [];
  const body = warnings.length
    ? `<p>Opening registration will create a personalised link for every active
        family and email it to them.</p>
       <div class="mt">${warnings.map((w) => `<div class="note note-${
         w.level === "error" ? "danger" : w.level === "warning" ? "warn" : ""}">${esc(w.message)}</div>`).join("")}</div>
       ${pf.blocking
         ? `<p class="small"><strong>The items in red will stop those families from
            being invited.</strong> You can fix them first, or continue and invite everyone else.</p>`
         : ""}`
    : `<p>Everything looks ready. Opening registration will create a personalised
        link for every active family and email it to them.</p>`;

  const choice = await modal({
    title: "Open Registration",
    body,
    buttons: [
      { value: null, label: "Cancel" },
      { value: "go", label: pf.blocking ? "Continue Anyway" : "Open Registration",
        class: pf.blocking ? "btn-danger" : "btn-primary" },
    ],
  });
  if (choice !== "go") return;

  const res = await api.openRegistration(semester.id, true);

  if (!res?.ok) {
    return toastErr(res?.error === "preflight_blocked"
      ? "Registration could not be opened."
      : (res?.error ?? "Could not open registration."));
  }

  const failures = (res.results ?? []).filter((r) => !r.ok);
  if (failures.length) {
    await modal({
      title: "Registration opened, with problems",
      body: `<p>${res.invited - failures.length} of ${res.invited} families were emailed
             their registration link.</p>
             <div class="note note-danger mt">These could not be sent:
             <ul>${failures.map((f) => `<li>${esc(f.family)} — ${esc(f.error ?? "unknown error")}</li>`).join("")}</ul></div>
             <p class="small">Fix the addresses and use Resend on the semester page.</p>`,
      buttons: [{ value: null, label: "Close", class: "btn-primary" }],
    });
  } else {
    toastOk(`Registration open. ${plural(res.invited, "family", "families")} invited.`);
  }
  refresh();
}

async function drawInvites(semester, invites) {
  const families = await api.families();
  const byFamily = new Map(invites.map((i) => [i.family_id, i]));

  render("#inviteList", `<div class="table-scroll"><table>
    <thead><tr><th>Family</th><th>Email</th><th>Invitation</th><th></th></tr></thead>
    <tbody>${families.filter((f) => f.active).map((f) => {
      const inv = byFamily.get(f.id);
      const state = !inv ? `<span class="badge badge-warn">Not sent</span>`
        : inv.send_error ? `<span class="badge badge-danger">Failed</span>
            <div class="tiny" style="color:var(--danger)">${esc(inv.send_error)}</div>`
        : inv.last_used_at ? `<span class="badge badge-ok">Opened</span>`
        : `<span class="badge">Sent</span>`;
      return `<tr>
        <td><a href="#/families/${esc(f.id)}">${esc(f.display_name)}</a></td>
        <td class="small ${f.primary_email ? "muted" : ""}">${f.primary_email
          ? esc(f.primary_email) : `<span style="color:var(--danger)">none</span>`}</td>
        <td>${state}</td>
        <td class="right nowrap">
          <button class="btn btn-sm btn-ghost" data-resend="${esc(f.id)}"
            ${f.primary_email ? "" : "disabled"}>Resend</button>
          ${inv ? `<button class="btn btn-sm btn-ghost" data-revoke="${esc(f.id)}">Revoke</button>` : ""}
        </td></tr>`;
    }).join("")}</tbody></table></div>`);

  document.querySelectorAll("[data-resend]").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      const res = await api.resendInvite(b.dataset.resend, semester.id);
      if (res?.ok) { toastOk("Invitation sent."); refresh(); }
      else { toastErr(res?.error ?? "Could not send."); b.disabled = false; }
    }));

  document.querySelectorAll("[data-revoke]").forEach((b) =>
    b.addEventListener("click", async () => {
      const ok = await confirmDialog("Revoke this invitation?",
        "The family's current link will stop working immediately. You can issue a new one with Resend.",
        "Revoke", true);
      if (!ok) return;
      const res = await api.revokeInvite(b.dataset.revoke, semester.id);
      if (res?.ok) { toastOk("Revoked."); refresh(); }
      else toastErr(res?.error ?? "Could not revoke.");
    }));
}

// =============================================================================
// Period detail — the class cards (§12)
// =============================================================================
export async function periodDetail(app, { id }) {
  const period = await api.period(id);
  const classes = await api.classes({ period_id: id }, { includeArchived: true });
  const semester = period.semesters;

  render(app, `<div class="wrap page">
    <div class="crumbs">
      <a href="#/semesters">Semesters</a><span>›</span>
      <a href="#/semesters/${esc(semester.id)}">${esc(semester.name)}</a><span>›</span>
      ${esc(period.display_name || `Period ${period.period_number}`)}
    </div>

    <div class="page-head">
      <div>
        <h1>${esc(period.display_name || `Period ${period.period_number}`)}</h1>
        <div class="sub">${esc(fmtTimeRange(period.start_time, period.end_time))}
          · ${plural(classes.filter((c) => !c.archived_at).length, "class", "classes")}</div>
      </div>
      <div class="btn-row">
        <button class="btn" id="editperiod">Edit Period</button>
        <button class="btn btn-primary" id="addclass">+ Add Class</button>
      </div>
    </div>

    ${classes.length
      ? `<div class="class-list">${classes.map(classRow).join("")}</div>`
      : `<div class="empty"><h3>No classes yet</h3>
          <p>Add the classes families can choose from in this period.</p></div>`}
  </div>`);

  $("#editperiod").addEventListener("click", async () => {
    const all = await api.periods(semester.id);
    periodDialog(semester.id, period, all);
  });
  $("#addclass").addEventListener("click", () => classDialog(period, null, classes));
}

// =============================================================================
// Class builder (§13)
// =============================================================================
async function classDialog(period, existing, siblings = []) {
  const nextOption = Math.max(0, ...siblings.map((c) => c.option_number ?? 0)) + 1;
  const v = await formDialog({
    title: existing ? `Edit ${existing.name}` : "Add Class",
    fields: [
      { name: "name", label: "Class name", value: existing?.name, required: true },
      { name: "teacher_name", label: "Teacher", value: existing?.teacher_name,
        placeholder: "Jane Smith", hint: "Free text — \"Jane Smith & Bob Jones\" is fine." },
      { name: "location", label: "Location", value: existing?.location,
        placeholder: "Fellowship Hall", hint: "Where the class meets. Appears on the printed roster." },
      { name: "description", label: "Description", type: "textarea", value: existing?.description,
        hint: "Families see this on the registration page." },
      { name: "capacity", label: "Capacity", type: "number", min: 0, value: existing?.capacity,
        hint: "Leave blank for no limit. Enforced by the database, not the browser." },
      { name: "age_min", label: "Minimum age", type: "number", min: 0, value: existing?.age_min,
        hint: "Age on the semester's first class day. Blank means no minimum." },
      { name: "age_max", label: "Maximum age", type: "number", min: 0, value: existing?.age_max },
      { name: "sex_requirement", label: "Open to", type: "select",
        value: existing?.sex_requirement ?? "any",
        options: [{ value: "any", label: "Anyone" },
                  { value: "female", label: "Girls only" },
                  { value: "male", label: "Boys only" }] },
      { name: "option_number", label: "Order in period", type: "number", min: 1,
        value: existing?.option_number ?? nextOption },
    ],
  });
  if (!v) return;

  try {
    if (existing) { await api.updateClass(existing.id, v); toastOk("Saved."); refresh(); }
    else {
      const c = await api.createClass({ ...v, period_id: period.id, semester_id: period.semester_id });
      toastOk(`${c.name} added.`);
      refresh();
    }
  } catch (e) { toastErr(e.message); }
}

// =============================================================================
// Class detail — roster, waitlist, manual changes (§14, §22)
// =============================================================================
export async function classDetail(app, { id }) {
  const [cls, roster, prefs] = await Promise.all([
    api.klass(id), api.classRoster(id),
    api.classPreferences(id).catch(() => []),
  ]);
  const period = cls.periods, semester = cls.semesters;
  const s = cls.seats ?? {};

  const registered = roster.filter((r) => r.status === "registered");
  const waitlisted = roster.filter((r) => r.status === "waitlisted")
    .sort((a, b) => (a.waitlisted_at ?? "").localeCompare(b.waitlisted_at ?? ""));
  const past = roster.filter((r) => r.status === "cancelled" || r.status === "withdrawn");
  const over = s.capacity != null && s.registered_count > s.capacity;
  // Ages are always quoted as of the semester's first class day (§5.3).
  const refDate = semester.class_start_date;

  // Children who named this class as their first choice and are not in it —
  // the people to look at first when a seat frees up (§22).
  const here = new Set(roster
    .filter((r) => r.status === "registered" || r.status === "waitlisted")
    .map((r) => r.child_id));
  const missedOut = prefs.filter((p) => p.rank === 1 && !here.has(p.child_id));

  render(app, `<div class="wrap page">
    <div class="crumbs">
      <a href="#/semesters">Semesters</a><span>›</span>
      <a href="#/semesters/${esc(semester.id)}">${esc(semester.name)}</a><span>›</span>
      <a href="#/periods/${esc(period.id)}">${esc(period.display_name || `Period ${period.period_number}`)}</a>
      <span>›</span>${esc(cls.name)}
    </div>

    <div class="page-head">
      <div>
        <h1>${esc(cls.name)}${cls.archived_at ? ` <span class="badge">Cancelled</span>` : ""}</h1>
        <div class="sub">${esc(fmtTimeRange(period.start_time, period.end_time))}
          ${cls.teacher_name ? ` · ${esc(cls.teacher_name)}` : ""}
          ${cls.location ? ` · ${esc(cls.location)}` : ""}
          ${eligibilityLabel(cls) ? ` · ${esc(eligibilityLabel(cls))}` : ""}</div>
      </div>
      <div class="btn-row">
        <a class="btn" href="#/classes/${esc(cls.id)}/print">Print Roster</a>
        <button class="btn" id="editclass">Edit Class</button>
        <button class="btn btn-primary" id="addstudent">+ Add Student</button>
      </div>
    </div>

    ${over ? `<div class="note note-danger">
      <strong>Over capacity.</strong> This class has ${s.registered_count} registrations
      for a capacity of ${s.capacity}.</div>` : ""}

    ${cls.description ? `<div class="card mb"><p>${esc(cls.description)}</p></div>` : ""}

    <div class="stats mb">
      ${statTile(s.registered_count ?? 0, "Enrolled")}
      ${statTile(s.capacity ?? "—", "Capacity")}
      ${statTile(s.capacity == null ? "—" : s.seats_open, "Seats open")}
      ${statTile(s.waitlisted_count ?? 0, "Waitlisted")}
    </div>

    <div class="card">
      <div class="card-head"><h3>Students</h3></div>
      ${registered.length ? studentTable(registered, false, refDate)
        : `<p class="muted">No students enrolled yet.</p>`}
    </div>

    ${waitlisted.length ? `<div class="card">
      <div class="card-head"><h3>Waitlist</h3></div>
      ${studentTable(waitlisted, true, refDate)}
    </div>` : ""}

    ${missedOut.length ? `<div class="card">
      <div class="card-head"><h3>Wanted this class</h3>
        <span class="small faint">First choice, placed elsewhere</span></div>
      <p class="small muted mb">These students asked for ${esc(cls.name)} first and
        ended up somewhere else because it was full. Worth checking here before you
        fill a freed seat from the waitlist.</p>
      <div class="table-scroll"><table><tbody>
        ${missedOut.map((p) => `<tr>
          <td><strong>${esc(p.children?.first_name ?? "")} ${esc(p.children?.last_name ?? "")}</strong></td>
          <td class="small"><a href="#/families/${esc(p.children?.family_id ?? "")}">${
            esc(p.children?.families?.display_name ?? "")}</a></td>
          <td class="right"><button class="btn btn-sm" data-place="${esc(p.child_id)}">Add</button></td>
        </tr>`).join("")}
      </tbody></table></div>
    </div>` : ""}

    ${past.length ? `<div class="card">
      <div class="card-head"><h3>Previously enrolled</h3>
        <span class="small faint">Kept for the record</span></div>
      <div class="table-scroll"><table><tbody>
        ${past.map((r) => `<tr style="opacity:.65">
          <td>${esc(r.children.first_name)} ${esc(r.children.last_name ?? "")}</td>
          <td class="small muted">${esc(r.children.families?.display_name ?? "")}</td>
          <td><span class="badge">${esc(r.status)}</span></td>
          <td class="right"><button class="btn btn-sm btn-ghost" data-restore="${esc(r.id)}">Re-enroll</button></td>
        </tr>`).join("")}
      </tbody></table></div>
    </div>` : ""}

    <div class="btn-row mt2">
      <button class="btn btn-danger" id="archiveclass">
        ${cls.archived_at ? "Restore Class" : "Cancel Class"}</button>
    </div>
  </div>`);

  $("#editclass").addEventListener("click", () => classDialog(period, cls));
  $("#addstudent").addEventListener("click", () => addStudent(cls));

  app.querySelectorAll("[data-remove]").forEach((b) =>
    b.addEventListener("click", async () => {
      const r = roster.find((x) => x.id === b.dataset.remove);
      const ok = await confirmDialog("Remove student?",
        `${r.children.first_name} will be withdrawn from ${cls.name}. The record is kept, not deleted.`,
        "Withdraw", true);
      if (!ok) return;
      try { await api.setRegistrationStatus(r.id, "withdrawn"); toastOk("Withdrawn."); refresh(); }
      catch (e) { toastErr(e.message); }
    }));

  app.querySelectorAll("[data-promote]").forEach((b) =>
    b.addEventListener("click", async () => {
      const r = roster.find((x) => x.id === b.dataset.promote);
      let res;
      try { res = await api.promoteWaitlist(r.id, false); }
      catch (e) { return toastErr(e.message); }

      if (res?.needs_override) {
        const ok = await overrideDialog("Promote from waitlist", res.warnings,
          `Promote ${r.children.first_name} anyway?`);
        if (!ok) return;
        try { await api.promoteWaitlist(r.id, true); }
        catch (e) { return toastErr(e.message); }
      }
      toastOk(`${r.children.first_name} promoted into the class.`);
      refresh();
    }));

  app.querySelectorAll("[data-place]").forEach((b) =>
    b.addEventListener("click", async () => {
      const p = missedOut.find((x) => x.child_id === b.dataset.place);
      const name = `${p.children?.first_name ?? ""} ${p.children?.last_name ?? ""}`.trim();
      let res;
      try { res = await api.placeChild(p.child_id, cls.id, "registered", false); }
      catch (e) { return toastErr(e.message); }

      if (res?.needs_override) {
        const reason = await overrideDialog(
          `Add ${name} to ${cls.name}?`, res.warnings, null, true);
        if (reason === null) return;
        try { await api.placeChild(p.child_id, cls.id, "registered", true, reason); }
        catch (e) { return toastErr(e.message); }
      }
      toastOk(`${name} moved into ${cls.name}.`);
      refresh();
    }));

  app.querySelectorAll("[data-restore]").forEach((b) =>
    b.addEventListener("click", async () => {
      const r = roster.find((x) => x.id === b.dataset.restore);
      try { await api.setRegistrationStatus(r.id, "registered"); toastOk("Re-enrolled."); refresh(); }
      catch (e) { toastErr(e.message); }
    }));

  $("#archiveclass").addEventListener("click", async () => {
    const archiving = !cls.archived_at;
    const ok = await confirmDialog(
      archiving ? "Cancel this class?" : "Restore this class?",
      archiving
        ? `${cls.name} will disappear from family registration pages. Existing registrations are kept, so you can see who was in it.`
        : `${cls.name} will be available to families again.`,
      archiving ? "Cancel Class" : "Restore", archiving);
    if (!ok) return;
    try {
      await api.archiveClass(cls.id, archiving);
      toastOk(archiving ? "Class cancelled." : "Class restored.");
      refresh();
    } catch (e) { toastErr(e.message); }
  });
}

function statTile(n, label) {
  return `<div class="stat"><span class="n">${esc(n)}</span><div class="l">${esc(label)}</div></div>`;
}

function studentTable(rows, isWaitlist, refDate) {
  return `<div class="table-scroll"><table>
    <thead><tr>
      ${isWaitlist ? "<th>#</th>" : ""}
      <th>Student</th><th class="num">Age</th><th>Contact</th>
      <th>Allergies</th><th>Medical</th><th></th>
    </tr></thead>
    <tbody>${rows.map((r, i) => {
      const ch = r.children ?? {};
      const fam = ch.families ?? {};
      const age = ageAt(ch.birth_date, refDate);
      const phone = familyPhone(fam);
      return `<tr>
      ${isWaitlist ? `<td class="num mono">${i + 1}</td>` : ""}
      <td><strong>${esc(ch.first_name)} ${esc(ch.last_name ?? "")}</strong>
        <div class="tiny faint"><a href="#/families/${esc(ch.family_id)}">${esc(fam.display_name ?? "")}</a></div>
        ${r.override_reason ? `<div class="tiny" style="color:var(--warn)">Override: ${esc(r.override_reason)}</div>` : ""}
        ${r.source === "admin" ? `<div class="tiny faint">Added by an administrator</div>` : ""}
        ${r.source === "waitlist_promotion" ? `<div class="tiny faint">Promoted from the waitlist</div>` : ""}</td>
      <td class="num mono">${age ?? `<span class="faint">—</span>`}</td>
      <td class="small">
        ${ch.email ? `<div>${esc(ch.email)}</div>` : ""}
        ${fam.primary_email ? `<div class="tiny faint">${esc(fam.primary_email)}</div>` : ""}
        ${phone ? `<div class="tiny faint mono">${esc(phone)}</div>` : ""}
        ${!ch.email && !fam.primary_email && !phone ? `<span class="faint">—</span>` : ""}</td>
      <td class="small">${ch.allergies
        ? `<span style="color:var(--danger)">${esc(ch.allergies)}</span>`
        : `<span class="faint">—</span>`}</td>
      <td class="small">${ch.medical_notes
        ? `<span style="color:var(--warn)">${esc(ch.medical_notes)}</span>`
        : `<span class="faint">—</span>`}</td>
      <td class="right nowrap">
        ${isWaitlist ? `<button class="btn btn-sm" data-promote="${esc(r.id)}">Promote</button>` : ""}
        <button class="btn btn-sm btn-ghost" data-remove="${esc(r.id)}">Remove</button>
      </td></tr>`;
    }).join("")}</tbody></table></div>`;
}

// -----------------------------------------------------------------------------
// Manual placement, with the override conversation (§22)
// -----------------------------------------------------------------------------
async function addStudent(cls) {
  const families = await api.families();
  const candidates = families.flatMap((f) =>
    (f.children ?? [])
      .filter((c) => c.active && !c.archived_at)
      .map((c) => ({ ...c, familyName: f.display_name })))
    .sort((a, b) => `${a.first_name}${a.last_name}`.localeCompare(`${b.first_name}${b.last_name}`));

  if (!candidates.length) return toastErr("There are no active children to add.");

  const v = await formDialog({
    title: `Add a student to ${cls.name}`,
    submitLabel: "Add",
    fields: [
      { name: "child_id", label: "Student", type: "select", required: true,
        options: candidates.map((c) => ({
          value: c.id, label: `${c.first_name} ${c.last_name ?? ""} — ${c.familyName}` })) },
      { name: "status", label: "Add as", type: "select", value: "registered",
        options: [{ value: "registered", label: "Enrolled" },
                  { value: "waitlisted", label: "On the waitlist" }] },
    ],
  });
  if (!v) return;

  let res;
  try { res = await api.placeChild(v.child_id, cls.id, v.status, false); }
  catch (e) { return toastErr(e.message); }

  if (res?.needs_override) {
    const child = candidates.find((c) => c.id === v.child_id);
    const reason = await overrideDialog(
      `Add ${child.first_name} to ${cls.name}?`, res.warnings, null, true);
    if (reason === null) return;
    try { await api.placeChild(v.child_id, cls.id, v.status, true, reason); }
    catch (e) { return toastErr(e.message); }
  }

  toastOk("Student added.");
  refresh();
}

/**
 * Show what rule the admin is about to break and make them say so on purpose.
 * With askReason, resolves to the typed reason (possibly ""), else null.
 * Without, resolves true/false.
 */
async function overrideDialog(title, warnings, question, askReason = false) {
  const body = `
    ${(warnings ?? []).map((w) => `<div class="note note-warn">${esc(w.message)}</div>`).join("")}
    ${question ? `<p class="mt">${esc(question)}</p>` : ""}
    ${askReason ? `<div class="field mt">
      <label for="ovr">Reason for the override</label>
      <input type="text" id="ovr" placeholder="Parent teaches the class">
      <div class="hint">Recorded against this registration and in the audit log.</div>
    </div>` : ""}`;

  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.innerHTML = `
      <div class="dialog-head"><h3>${esc(title)}</h3></div>
      <div class="dialog-body">${body}</div>
      <div class="dialog-foot">
        <button type="button" class="btn" data-choice="cancel">Cancel</button>
        <button type="button" class="btn btn-danger" data-choice="ok">Override Anyway</button>
      </div>`;

    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      const reason = dlg.querySelector("#ovr")?.value ?? "";
      try { dlg.close(); } catch { /* already closed */ }
      dlg.remove();
      resolve(askReason ? (ok ? reason : null) : ok);
    };

    dlg.querySelectorAll("button[data-choice]").forEach((b) =>
      b.addEventListener("click", (e) => { e.preventDefault(); finish(b.dataset.choice === "ok"); }));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(false); });
    dlg.addEventListener("close", () => finish(false));

    document.body.appendChild(dlg);
    dlg.showModal();
    dlg.querySelector("#ovr, .btn")?.focus();
  });
}
