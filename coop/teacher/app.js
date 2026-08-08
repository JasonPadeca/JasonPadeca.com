// =============================================================================
// The teacher page.
//
// Everything here is centred on a week and a class, because that is how a
// teacher actually uses it: it is Thursday morning, who is in my room, and who
// is not coming.
//
// The default is the next class day, with arrows to move a week either way —
// backwards because a handout from a fortnight ago is still the handout, and
// forwards because a teacher planning next week wants to know who has already
// said they will be away.
//
// What is visible is bounded by what they teach. Not by hiding fields in the
// page — by the database refusing to return anything else. A teacher reading
// `children` gets their own students and nobody else, so a mistake here is a
// missing name rather than another family's medical notes.
// =============================================================================

import { auth, api, IS_CONFIGURED } from "../assets/api.js";
import {
  esc, $, render, fmtDate, fmtTimeRange, toastErr, plural, eligibilityLabel,
} from "../assets/ui.js";

const app = document.getElementById("app");
let ME = null;

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------
(async function boot() {
  if (!IS_CONFIGURED) {
    return render(app, `<div class="wrap page"><div class="note note-danger">
      This site is not configured yet.</div></div>`);
  }

  const session = await auth.session().catch(() => null);
  if (!session) return signedOut();

  try {
    ME = await auth.establishSession();
  } catch (e) {
    return signedOut(e.message);
  }

  if (!ME?.is_teacher || !(ME.teaches ?? []).length) return notATeacher();

  window.addEventListener("hashchange", route);
  await route();
})();

function signedOut(message) {
  render(app, `<div class="signin-page"><div class="signin-card">
    <img src="../assets/koinonia-logo.jpg" alt="" class="signin-mark" width="72" height="72">
    <h1>Koinonia Teachers</h1>
    ${message ? `<div class="note note-danger">${esc(message)}</div>` : ""}
    <p class="signin-sub">Sign in with the email address the co-op has for you.</p>
    <a class="btn btn-primary btn-block" href="../portal/">Sign in</a>
  </div></div>`);
}

/**
 * Signed in, but teaching nothing.
 *
 * Kept distinct from "not recognised": somebody whose teaching finished last
 * term is not an intruder, and telling them so would be both wrong and rude.
 */
function notATeacher() {
  const hasFamily = (ME?.families ?? []).length > 0;
  render(app, `<div class="signin-page"><div class="signin-card">
    <img src="../assets/koinonia-logo.jpg" alt="" class="signin-mark" width="72" height="72">
    <h1>No classes assigned</h1>
    <p class="signin-sub">You are signed in as <strong>${esc(ME?.email ?? "")}</strong>,
      but you are not down as teaching anything this semester.</p>
    <p class="signin-sub">If that is not right, an administrator can add you to
      your class.</p>
    ${hasFamily ? `<a class="btn btn-primary btn-block" href="../portal/">Go to your family page</a>`
      : `<button class="btn btn-block" id="out">Sign out</button>`}
  </div></div>`);
  $("#out")?.addEventListener("click", async () => {
    await auth.signOut();
    location.href = "../portal/";
  });
}

// -----------------------------------------------------------------------------
// Routing. Two screens: the week, and one class within it.
// -----------------------------------------------------------------------------
async function route() {
  const hash = location.hash || "#/";
  const [, screen, id] = hash.split("?")[0].split("/");
  try {
    if (screen === "class" && id) await classView(id);
    else await weekView();
  } catch (e) {
    console.error(e);
    render(app, `<div class="wrap page"><div class="note note-danger">
      <strong>Could not load this page.</strong>
      <div class="mt tiny">${esc(e.message)}</div></div></div>`);
  }
}

function chrome(inner) {
  const hasFamily = (ME.families ?? []).length > 0;
  return `
    <nav class="topbar">
      <div class="wrap">
        <a class="brand" href="./">
          <img src="../assets/koinonia-logo.jpg" alt="" width="26" height="26" class="brand-mark">
          <span><strong>Koinonia</strong> <span class="brand-sub">Teaching</span></span>
        </a>
        <div class="spacer"></div>
        ${hasFamily ? `<a class="btn btn-sm" href="../portal/">My Family</a>` : ""}
        ${ME.is_admin ? `<a class="btn btn-sm" href="../admin/">Administration</a>` : ""}
        <button class="btn btn-sm btn-ghost" id="out">Sign out</button>
      </div>
    </nav>
    ${inner}`;
}

function wireChrome() {
  $("#out")?.addEventListener("click", async () => {
    await auth.signOut();
    location.href = "../portal/";
  });
}

// -----------------------------------------------------------------------------
// The week
// -----------------------------------------------------------------------------
async function weekView() {
  const teaches = ME.teaches ?? [];
  const semesterId = teaches[0].semester_id;

  const meetings = await api.meetings(semesterId);
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const meeting = pickMeeting(meetings, params.get("on"));

  if (!meeting) {
    render(app, chrome(`<div class="wrap page">
      <div class="page-head"><div><h1>Your classes</h1>
        <div class="sub">${esc(teaches[0].semester_name)}</div></div></div>
      <div class="note note-warn">This semester has no class days on its calendar
        yet. An administrator needs to build it before absences or weekly notes
        can appear.</div>
      ${teaches.map(classCard).join("")}
    </div>`));
    return wireChrome();
  }

  const idx = meetings.findIndex((m) => m.id === meeting.id);
  const prev = meetings[idx - 1];
  const next = meetings[idx + 1];

  // Absences for this week, across every class this person teaches. RLS has
  // already limited these to their own students.
  let away = [];
  try {
    away = await api.absencesForMeeting(meeting.id);
  } catch { /* the week still renders without it */ }

  const awayByClass = new Map();
  for (const a of away) {
    for (const t of teaches) {
      const inThisClass = a.periods.length === 0
        ? true                                     // whole day
        : a.periods.includes(t.period_number);
      if (!inThisClass) continue;
      if (!awayByClass.has(t.class_id)) awayByClass.set(t.class_id, []);
      awayByClass.get(t.class_id).push(a);
    }
  }

  render(app, chrome(`<div class="wrap page">
    <div class="page-head">
      <div><h1>Your classes</h1>
        <div class="sub">${esc(teaches[0].semester_name)}${
          ME.teacher_name ? ` · ${esc(ME.teacher_name)}` : ""}</div></div>
    </div>

    <div class="weekbar">
      <a class="btn btn-sm ${prev ? "" : "is-disabled"}"
         href="${prev ? `#/?on=${esc(prev.meets_on)}` : "#"}"
         ${prev ? "" : 'aria-disabled="true" tabindex="-1"'}>← Previous</a>
      <div class="weekbar-date">
        <strong>${esc(fmtDate(meeting.meets_on))}</strong>
        ${isToday(meeting.meets_on) ? `<span class="badge badge-ok">Today</span>` : ""}
        ${meeting.cancelled
          ? `<div class="tiny" style="color:var(--danger)">No class${
              meeting.cancel_reason ? ` — ${esc(meeting.cancel_reason)}` : ""}</div>`
          : meeting.note ? `<div class="tiny faint">${esc(meeting.note)}</div>` : ""}
      </div>
      <a class="btn btn-sm ${next ? "" : "is-disabled"}"
         href="${next ? `#/?on=${esc(next.meets_on)}` : "#"}"
         ${next ? "" : 'aria-disabled="true" tabindex="-1"'}>Next →</a>
    </div>

    ${meeting.cancelled ? `<div class="note note-warn">
      There is no class on this date${meeting.cancel_reason
        ? ` — ${esc(meeting.cancel_reason)}` : ""}.</div>` : ""}

    ${teaches.map((t) => classCard(t, awayByClass.get(t.class_id) ?? [], meeting)).join("")}
  </div>`));

  wireChrome();
}

function classCard(t, away = [], meeting = null) {
  return `<a class="card card-link" href="#/class/${esc(t.class_id)}${
      meeting ? `?on=${esc(meeting.meets_on)}` : ""}">
    <div class="card-head" style="margin:0">
      <div>
        <h3>${esc(t.class_name)}</h3>
        <div class="small muted">${esc(t.period_name)}</div>
      </div>
      ${away.length
        ? `<span class="badge badge-warn">${plural(away.length, "away")}</span>`
        : meeting && !meeting.cancelled
          ? `<span class="badge badge-ok">All in</span>` : ""}
    </div>
    ${away.length ? `<div class="small mt">
      Away: ${away.map((a) => esc(a.child_name)).join(", ")}</div>` : ""}
  </a>`;
}

// -----------------------------------------------------------------------------
// One class, on one week
// -----------------------------------------------------------------------------
async function classView(classId) {
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const on = params.get("on");

  const teaches = ME.teaches ?? [];
  const meetings = await api.meetings(teaches[0].semester_id);
  const meeting = pickMeeting(meetings, on);

  const view = await api.teacherClass(classId, meeting?.id ?? null);
  const c = view.class, p = view.period;
  const students = view.students ?? [];
  const flagged = students.filter((s) => s.allergies || s.medical_notes);
  const absent = students.filter((s) => s.absent);

  const idx = meetings.findIndex((m) => m.id === meeting?.id);
  const prev = meetings[idx - 1], next = meetings[idx + 1];
  const q = (m) => `#/class/${esc(classId)}?on=${esc(m.meets_on)}`;

  render(app, chrome(`<div class="wrap page">
    <div class="crumbs"><a href="#/">Your classes</a><span>›</span>${esc(c.name)}</div>

    <div class="page-head">
      <div>
        <h1>${esc(c.name)}</h1>
        <div class="sub">${esc(p?.name ?? "")} ${esc(fmtTimeRange(p?.start_time, p?.end_time))}
          ${c.location ? ` · ${esc(c.location)}` : ""}
          ${eligibilityLabel(c) ? ` · ${esc(eligibilityLabel(c))}` : ""}</div>
      </div>
      <div class="btn-row">
        <a class="btn" href="#/">← All classes</a>
      </div>
    </div>

    ${meeting ? `<div class="weekbar">
      <a class="btn btn-sm ${prev ? "" : "is-disabled"}"
         href="${prev ? q(prev) : "#"}" ${prev ? "" : 'aria-disabled="true" tabindex="-1"'}>← Previous</a>
      <div class="weekbar-date">
        <strong>${esc(fmtDate(meeting.meets_on))}</strong>
        ${isToday(meeting.meets_on) ? `<span class="badge badge-ok">Today</span>` : ""}
        ${meeting.cancelled
          ? `<div class="tiny" style="color:var(--danger)">No class${
              meeting.cancel_reason ? ` — ${esc(meeting.cancel_reason)}` : ""}</div>`
          : meeting.note ? `<div class="tiny faint">${esc(meeting.note)}</div>` : ""}
      </div>
      <a class="btn btn-sm ${next ? "" : "is-disabled"}"
         href="${next ? q(next) : "#"}" ${next ? "" : 'aria-disabled="true" tabindex="-1"'}>Next →</a>
    </div>` : ""}

    ${absent.length ? `<div class="note note-warn">
      <strong>${plural(absent.length, "student")} away this week:</strong>
      ${absent.map((s) => `${esc(s.name)}${s.absence_reason
        ? ` <span class="faint">(${esc(s.absence_reason)})</span>` : ""}`).join(", ")}
    </div>` : ""}

    ${flagged.length ? `<div class="card">
      <div class="card-head"><h3>Allergies &amp; medical</h3></div>
      ${flagged.map((s) => `<div class="alert-row">
        <strong>${esc(s.name)}</strong>
        ${s.allergies ? `<span class="tag">Allergy</span> ${esc(s.allergies)}` : ""}
        ${s.allergies && s.medical_notes ? " · " : ""}
        ${s.medical_notes ? `<span class="tag">Medical</span> ${esc(s.medical_notes)}` : ""}
      </div>`).join("")}
    </div>` : ""}

    <div class="card">
      <div class="card-head"><h3>Students</h3>
        <span class="badge">${plural(students.length, "student")}</span></div>
      ${students.length ? `<div class="table-scroll"><table>
        <thead><tr><th>Name</th><th class="num">Age</th><th>Contact</th>
          <th>Allergies / medical</th><th></th></tr></thead>
        <tbody>${students.map((s) => `<tr${s.absent ? ' style="opacity:.5"' : ""}>
          <td><strong>${esc(s.name)}</strong>
            <div class="tiny faint">${esc(s.family_name ?? "")}</div></td>
          <td class="num mono">${s.age ?? `<span class="faint">—</span>`}</td>
          <td class="small">
            ${s.email ? `<div>${esc(s.email)}</div>` : ""}
            ${s.family_phone ? `<div class="tiny faint mono">${esc(s.family_phone)}</div>` : ""}
            ${s.family_email ? `<div class="tiny faint">${esc(s.family_email)}</div>` : ""}</td>
          <td class="small">${[s.allergies, s.medical_notes].filter(Boolean).map(esc).join(" · ")
            || `<span class="faint">—</span>`}</td>
          <td class="right nowrap">${s.absent
            ? `<span class="badge badge-warn">Away</span>` : ""}</td>
        </tr>`).join("")}</tbody></table></div>`
        : `<p class="muted">Nobody is registered for this class yet.</p>`}
    </div>

    ${(view.helpers ?? []).length ? `<div class="card">
      <div class="card-head"><h3>Helpers</h3></div>
      <p class="small muted">Volunteering with this class. They are not students
        here and do not use a seat.</p>
      ${view.helpers.map((h) => `<div class="small">${esc(h.name)}${
        h.note ? ` <span class="faint">— ${esc(h.note)}</span>` : ""}</div>`).join("")}
    </div>` : ""}
  </div>`));

  wireChrome();
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** The named week, else the next one still to come, else the last one held. */
function pickMeeting(meetings, wanted) {
  if (!meetings?.length) return null;
  if (wanted) {
    const exact = meetings.find((m) => m.meets_on === wanted);
    if (exact) return exact;
  }
  const today = todayISO();
  return meetings.find((m) => m.meets_on >= today) ?? meetings[meetings.length - 1];
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isToday(iso) {
  return iso === todayISO();
}
