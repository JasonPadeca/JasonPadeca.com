// =============================================================================
// A parent's week.
//
// The page opens on the next class day and moves a week at a time. Backwards
// matters as much as forwards: a handout from a fortnight ago is still the
// handout, and "what was that worksheet" is a question asked far more often
// than "what is coming".
//
// One card per child, their classes down it, and anything a teacher or the
// office posted. A class a child will miss is struck through rather than
// hidden — the parent reported that absence themselves and needs to see it
// took.
// =============================================================================

import { api } from "../assets/api.js";
import {
  esc, $, render, fmtDate, fmtTimeRange, toastErr, plural,
} from "../assets/ui.js";

export async function render_(container, { meetings, onNeedsRefresh }) {
  if (!meetings?.length) {
    return render(container, `<div class="card">
      <div class="card-head"><h3>This week</h3></div>
      <p class="muted">The class calendar for this semester has not been set up
        yet.</p>
    </div>`);
  }

  const params = new URLSearchParams(location.hash.slice(1));
  const meeting = pick(meetings, params.get("on"));
  const idx = meetings.findIndex((m) => m.id === meeting.id);
  const prev = meetings[idx - 1], next = meetings[idx + 1];

  render(container, `<div class="card">
    <div class="loading"><span class="spinner"></span> Loading…</div>
  </div>`);

  let week;
  try {
    week = await api.familyWeek(meeting.id);
  } catch (e) {
    return render(container, `<div class="note note-danger">${esc(e.message)}</div>`);
  }

  const children = week.children ?? [];
  const posts = week.posts ?? [];
  const go = (m) => `#on=${esc(m.meets_on)}`;

  render(container, `
    <div class="weekbar">
      <a class="btn btn-sm ${prev ? "" : "is-disabled"}"
         href="${prev ? go(prev) : "#"}" ${prev ? "" : 'aria-disabled="true" tabindex="-1"'}>← Previous</a>
      <div class="weekbar-date">
        <strong>${esc(fmtDate(meeting.meets_on))}</strong>
        ${isToday(meeting.meets_on) ? `<span class="badge badge-ok">Today</span>` : ""}
        ${meeting.note ? `<div class="tiny faint">${esc(meeting.note)}</div>` : ""}
      </div>
      <a class="btn btn-sm ${next ? "" : "is-disabled"}"
         href="${next ? go(next) : "#"}" ${next ? "" : 'aria-disabled="true" tabindex="-1"'}>Next →</a>
    </div>

    ${meeting.cancelled ? `<div class="note note-warn">
      <strong>No class on this day.</strong>${
        meeting.cancel_reason ? ` ${esc(meeting.cancel_reason)}` : ""}</div>` : ""}

    ${posts.length ? `<div class="card">
      <div class="card-head"><h3>Notes &amp; handouts</h3></div>
      ${posts.map((p) => `<div class="post">
        <div class="post-head">
          <strong>${esc(p.title)}</strong>
          ${p.class_name ? `<span class="badge">${esc(p.class_name)}</span>`
            : `<span class="badge badge-ok">Everyone</span>`}
          ${p.for_this_week ? "" : `<span class="tiny faint">all term</span>`}
        </div>
        ${p.body ? `<div class="small mt">${esc(p.body)}</div>` : ""}
        ${p.link_url ? `<div class="mt"><a href="${esc(p.link_url)}" target="_blank"
          rel="noopener noreferrer">${esc(p.link_label || "Open the link")}</a></div>` : ""}
        ${p.file_path ? `<div class="mt">
          <a href="#" data-file="${esc(p.file_path)}">${esc(p.file_name || "Download")}</a></div>` : ""}
        <div class="tiny faint mt">${esc(p.posted_by ?? "")}</div>
      </div>`).join("")}
    </div>` : ""}

    ${children.length ? children.map((ch) => `
      <div class="card">
        <div class="card-head">
          <h3>${esc(ch.name)}</h3>
          ${ch.absent ? `<span class="badge badge-warn">${
            ch.absence_whole_day ? "Away all day" : "Away part of the day"}</span>` : ""}
        </div>
        ${ch.classes.length ? `<div class="table-scroll"><table>
          <tbody>${ch.classes.map((c) => `<tr${c.missing ? ' style="opacity:.5"' : ""}>
            <td style="width:7rem" class="small muted">${esc(c.period_name)}<br>
              <span class="tiny faint">${esc(fmtTimeRange(c.start_time, c.end_time))}</span></td>
            <td><strong${c.missing ? ' style="text-decoration:line-through"' : ""}>${esc(c.class_name)}</strong>
              <div class="tiny faint">${esc(c.teacher_name ?? "")}${
                c.location ? ` · ${esc(c.location)}` : ""}</div></td>
            <td class="right nowrap">
              <button class="btn btn-sm btn-ghost" data-who="${esc(c.class_id)}"
                      data-name="${esc(c.class_name)}">Who else?</button>
            </td>
          </tr>`).join("")}</tbody></table></div>`
          : `<p class="muted small">Not registered for any classes this semester.</p>`}
      </div>`).join("")
      : `<div class="card"><p class="muted">No children on your family record yet.</p></div>`}
  `);

  container.querySelectorAll("[data-file]").forEach((a) =>
    a.addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        window.open(await api.handoutUrl(a.dataset.file), "_blank", "noopener");
      } catch (err) { toastErr(err.message); }
    }));

  // Names only. The function behind this returns nothing else, so there is no
  // filtering here to get wrong.
  container.querySelectorAll("[data-who]").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        const list = await api.classmates(b.dataset.who);
        const dlg = document.createElement("dialog");
        dlg.className = "modal";
        dlg.innerHTML = `<form method="dialog">
          <h3>${esc(b.dataset.name)}</h3>
          <p class="small muted">${plural(list.length, "student")} in this class.</p>
          <div class="mt">${list.length
            ? list.map((s) => `<div>${esc(s.name)}</div>`).join("")
            : `<span class="muted">Nobody registered yet.</span>`}</div>
          <div class="modal-actions">
            <button class="btn btn-primary" value="ok" type="submit">Close</button>
          </div></form>`;
        document.body.appendChild(dlg);
        dlg.showModal();
        dlg.addEventListener("close", () => dlg.remove());
      } catch (e) {
        toastErr(e.message);
      } finally {
        b.disabled = false;
      }
    }));
}

/** The named week, else the next one still to come, else the last one held. */
function pick(meetings, wanted) {
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

function isToday(iso) { return iso === todayISO(); }
