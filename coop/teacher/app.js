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

import { auth, api, IS_CONFIGURED, needsFresh } from "../assets/api.js";
import {
  esc, $, render, fmtDate, fmtTimeRange, toastOk, toastErr, plural, eligibilityLabel,
} from "../assets/ui.js";

const app = document.getElementById("app");
let ME = null;

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------
(async function boot() {
  // See needsFresh in api.js.
  if (needsFresh(["teacherClass"])) return;

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

    <div class="card">
      <div class="card-head"><h3>This week's notes &amp; handouts</h3>
        <button class="btn btn-sm btn-primary" id="post">+ Post something</button></div>
      <div id="posts"><div class="loading"><span class="spinner"></span></div></div>
    </div>

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
        : `<p class="muted">Nobody has signed up for this class yet.</p>`}
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
  drawPosts(classId, view, meeting);
}

// -----------------------------------------------------------------------------
// Notes and handouts for a class.
//
// Anything attached to THIS week, plus anything standing for the term — a
// supply list posted in September is still what a parent needs in November.
// -----------------------------------------------------------------------------
async function drawPosts(classId, view, meeting) {
  let posts = [];
  try {
    posts = await api.announcements({ classId });
  } catch (e) {
    return render("#posts", `<div class="note note-danger">${esc(e.message)}</div>`);
  }

  const shown = posts.filter((p) =>
    !p.meeting_id || (meeting && p.meeting_id === meeting.id));

  render("#posts", shown.length ? shown.map((p) => `
    <div class="post">
      <div class="post-head">
        <strong>${esc(p.title)}</strong>
        ${p.meeting_id
          ? `<span class="badge">${esc(fmtDate(p.meeting_dates?.meets_on))}</span>`
          : `<span class="badge badge-ok">All term</span>`}
      </div>
      ${p.body ? `<div class="small mt">${esc(p.body)}</div>` : ""}
      ${p.link_url ? `<div class="mt"><a href="${esc(p.link_url)}" target="_blank"
        rel="noopener noreferrer">${esc(p.link_label || p.link_url)}</a></div>` : ""}
      ${p.file_path ? `<div class="mt">
        <a href="#" data-file="${esc(p.file_path)}">${esc(p.file_name || "Download")}</a></div>` : ""}
      <div class="tiny faint mt">${esc(p.posted_by_name ?? "")}
        · ${esc(new Date(p.created_at).toLocaleDateString())}
        · <a href="#" data-del="${esc(p.id)}">remove</a></div>
    </div>`).join("")
    : `<p class="muted">Nothing posted for this week. Anything you add here is
       visible to the families of children in this class, and to nobody else.</p>`);

  // Signed on demand rather than stored: the bucket is private, and a URL that
  // worked forever would outlive the policy that granted it.
  document.querySelectorAll("[data-file]").forEach((a) =>
    a.addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        window.open(await api.handoutUrl(a.dataset.file), "_blank", "noopener");
      } catch (err) { toastErr(err.message); }
    }));

  document.querySelectorAll("[data-del]").forEach((a) =>
    a.addEventListener("click", async (e) => {
      e.preventDefault();
      if (!confirm("Remove this post? Families will no longer see it.")) return;
      try {
        await api.deleteAnnouncement(a.dataset.del);
        drawPosts(classId, view, meeting);
      } catch (err) { toastErr(err.message); }
    }));

  $("#post")?.addEventListener("click", () => openPostForm(classId, view, meeting));
}

function openPostForm(classId, view, meeting) {
  const dlg = document.createElement("dialog");
  dlg.className = "modal";
  dlg.innerHTML = `
    <form method="dialog">
      <h3>Post to ${esc(view.class.name)}</h3>
      <div class="field">
        <label for="p-title">Title</label>
        <input type="text" id="p-title" maxlength="120" required
               placeholder="Worksheet for this week">
      </div>
      <div class="field">
        <label for="p-body">Message <span class="faint">(optional)</span></label>
        <textarea id="p-body" rows="3" placeholder="Please print it before Thursday."></textarea>
      </div>
      <div class="field">
        <label for="p-link">Link <span class="faint">(optional)</span></label>
        <input type="url" id="p-link" placeholder="https://drive.google.com/…">
        <div class="hint">A Google Drive link works well and uses none of the
          co-op's storage.</div>
      </div>
      <div class="field">
        <label for="p-file">Or upload a file <span class="faint">(optional)</span></label>
        <input type="file" id="p-file">
        <div class="hint">Up to 10 MB.</div>
      </div>
      <div class="field">
        <label for="p-when">Applies to</label>
        <select id="p-when">
          ${meeting ? `<option value="week">Just ${esc(fmtDate(meeting.meets_on))}</option>` : ""}
          <option value="term">The whole term</option>
        </select>
      </div>
      <div class="modal-actions">
        <button class="btn" value="cancel" type="submit">Cancel</button>
        <button class="btn btn-primary" id="p-save" type="button">Post it</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  dlg.addEventListener("close", () => dlg.remove());

  dlg.querySelector("#p-save").addEventListener("click", async () => {
    const title = dlg.querySelector("#p-title").value.trim();
    const body = dlg.querySelector("#p-body").value.trim() || null;
    const link = dlg.querySelector("#p-link").value.trim() || null;
    const file = dlg.querySelector("#p-file").files[0] ?? null;
    const when = dlg.querySelector("#p-when").value;

    if (!title) return toastErr("Give it a title.");
    if (!body && !link && !file) {
      return toastErr("Add a message, a link, or a file — otherwise there is nothing to post.");
    }

    const btn = dlg.querySelector("#p-save");
    btn.disabled = true;
    btn.textContent = file ? "Uploading…" : "Posting…";
    try {
      let uploaded = null;
      if (file) uploaded = await api.uploadHandout(classId, file);

      await api.postAnnouncement({
        semester_id: view.semester.id,
        class_id: classId,
        meeting_id: when === "week" && meeting ? meeting.id : null,
        title, body,
        link_url: link,
        link_label: link ? "Open the link" : null,
        file_path: uploaded?.path ?? null,
        file_name: uploaded?.name ?? null,
        file_size: uploaded?.size ?? null,
        posted_by_name: ME.teacher_name || ME.email,
      });
      dlg.close();
      toastOk("Posted. Families in this class will see it.");
      drawPosts(classId, view, meeting);
    } catch (e) {
      toastErr(e.message);
      btn.disabled = false;
      btn.textContent = "Post it";
    }
  });
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
