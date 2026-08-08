// =============================================================================
// Dashboard (§8) — what an administrator needs to know at a glance.
//
// The numbers are the easy part. The alerts below them are the point: things
// that will otherwise be discovered by a parent, which is the expensive way to
// discover them.
// =============================================================================

import { api } from "../../assets/api.js";
import { esc, render, fmtDate, relTime, plural } from "../../assets/ui.js";

export async function show(app) {
  const semesters = await api.semesters();

  // The semester an admin means when they say "this semester": the one open for
  // registration, else the most recent one that isn't a draft, else anything.
  const current =
    semesters.find((s) => s.status === "registration_open") ??
    semesters.find((s) => s.status === "active") ??
    semesters.find((s) => s.status !== "draft") ??
    semesters[0];

  if (!current) {
    return render(app, `<div class="wrap page">
      <div class="page-head"><div><h1>Dashboard</h1></div></div>
      <div class="empty">
        <h3>Nothing set up yet</h3>
        <p>Start by adding the families in your co-op, then build a semester.</p>
        <div class="btn-row mt2" style="justify-content:center">
          <a class="btn btn-primary" href="#/families">Add Families</a>
          <a class="btn" href="#/semesters">Create a Semester</a>
        </div>
      </div>
    </div>`);
  }

  const [summary, classes, invites, status, families] = await Promise.all([
    api.summary(current.id),
    api.classes({ semester_id: current.id }),
    api.invites(current.id),
    api.systemStatus().catch(() => null),
    api.families(),
  ]);

  // Children sitting the semester out have answered; they are not outstanding.
  const sittingOut = summary.sitting_out ?? 0;
  const notRegistered =
    summary.active_children - summary.children_registered - sittingOut;

  render(app, `<div class="wrap page">
    <div class="page-head">
      <div>
        <h1>${esc(current.name)}</h1>
        <div class="sub">
          ${statusBadge(current)}
          ${current.class_start_date
            ? ` · ${esc(fmtDate(current.class_start_date))} – ${esc(fmtDate(current.class_end_date))}` : ""}
        </div>
      </div>
      <div class="btn-row">
        <a class="btn" href="#/semesters/${esc(current.id)}">Open Semester</a>
      </div>
    </div>

    <div class="stats">
      ${stat(summary.active_children, "Active children")}
      ${stat(summary.children_registered, "Registered")}
      ${stat(notRegistered, "Not yet registered", notRegistered > 0 ? "attn" : "")}
      ${sittingOut ? stat(sittingOut, "Sitting out") : ""}
      ${stat(summary.confirmed_seats, "Confirmed seats")}
      ${stat(summary.waitlisted, "Waitlisted", summary.waitlisted > 0 ? "attn" : "")}
      ${stat(summary.classes_full, "Classes full")}
    </div>

    ${renderAlerts(current, summary, classes, invites, families)}

    <div class="card mt2">
      <div class="card-head"><h3>Classes</h3>
        <a class="btn btn-sm" href="#/semesters/${esc(current.id)}">Manage</a></div>
      ${renderClassSnapshot(classes)}
    </div>

    <p class="tiny faint mt2">
      Backend status: ${status ? "OK" : "unknown"}${
        status?.last_keepalive_at ? ` · last keepalive ${esc(relTime(status.last_keepalive_at))}` : ""}
    </p>
  </div>`);
}

function stat(n, label, kind = "") {
  return `<div class="stat ${kind}"><span class="n">${n ?? 0}</span><div class="l">${esc(label)}</div></div>`;
}

export function statusBadge(s) {
  const map = {
    draft: ["", "Draft"],
    registration_open: ["badge-ok", "Registration Open"],
    registration_closed: ["badge-warn", "Registration Closed"],
    active: ["badge-accent", "Active"],
    completed: ["", "Completed"],
    archived: ["", "Archived"],
  };
  const [cls, label] = map[s.status] ?? ["", s.status];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

// -----------------------------------------------------------------------------
// Alerts — the "you are about to have a problem" list (§8).
// -----------------------------------------------------------------------------
function renderAlerts(semester, summary, classes, invites, families) {
  const alerts = [];

  if (summary.classes_over_capacity > 0) {
    alerts.push(["danger",
      `${plural(summary.classes_over_capacity, "class", "classes")} ${
        summary.classes_over_capacity === 1 ? "is" : "are"} over capacity because of a manual override.`]);
  }

  if (summary.invite_failures > 0) {
    alerts.push(["danger",
      `${plural(summary.invite_failures, "invitation")} could not be delivered. ` +
      `Check the family's email address and resend from the Semester page.`]);
  }

  if (semester.status === "registration_open") {
    const invited = new Set(invites.map((i) => i.family_id));
    const missing = families.filter((f) => f.active && !invited.has(f.id));
    if (missing.length) {
      alerts.push(["warn",
        `${plural(missing.length, "active family", "active families")} ${
          missing.length === 1 ? "has" : "have"} no registration invitation: ` +
        missing.slice(0, 5).map((f) => f.display_name).join(", ") +
        (missing.length > 5 ? `, and ${missing.length - 5} more` : "") + "."]);
    }

    const noEmail = families.filter((f) => f.active && !f.primary_email);
    if (noEmail.length) {
      alerts.push(["danger",
        `${plural(noEmail.length, "active family", "active families")} ${
          noEmail.length === 1 ? "has" : "have"} no email address: ` +
        noEmail.map((f) => f.display_name).join(", ") + "."]);
    }
  }

  const noTeacher = classes.filter((c) => !c.teacher_name?.trim());
  if (noTeacher.length) {
    alerts.push(["warn",
      `${plural(noTeacher.length, "class", "classes")} ${
        noTeacher.length === 1 ? "has" : "have"} no teacher listed: ` +
      noTeacher.map((c) => c.name).join(", ") + "."]);
  }

  const noDob = families.flatMap((f) =>
    (f.children ?? []).filter((c) => c.active && !c.archived_at && !c.birth_date));
  if (noDob.length) {
    alerts.push(["warn",
      `${plural(noDob.length, "active child", "active children")} ${
        noDob.length === 1 ? "has" : "have"} no birth date, so age eligibility cannot be checked: ` +
      noDob.map((c) => `${c.first_name} ${c.last_name ?? ""}`.trim()).join(", ") + "."]);
  }

  if (!alerts.length) {
    return `<div class="note note-ok mt2">Nothing needs your attention.</div>`;
  }

  // Worst first — an undeliverable invitation matters more than a blank teacher.
  const order = { danger: 0, warn: 1 };
  alerts.sort((a, b) => order[a[0]] - order[b[0]]);

  return `<div class="mt2">${alerts.map(([kind, msg]) =>
    `<div class="note note-${kind}">${esc(msg)}</div>`).join("")}</div>`;
}

function renderClassSnapshot(classes) {
  if (!classes.length) return `<p class="muted">No classes in this semester yet.</p>`;

  return `<div class="class-list">${classes.map((c) => {
    const s = c.seats ?? {};
    const over = s.capacity != null && s.registered_count > s.capacity;
    const pct = s.capacity ? Math.min(100, (s.registered_count / s.capacity) * 100) : 0;
    return `<a class="class-row" href="#/classes/${esc(c.id)}">
      <span class="cr-main">
        <span class="cr-name">${esc(c.name)}</span>
        <span class="cr-meta">${esc(c.teacher_name || "No teacher listed")}</span>
      </span>
      <span class="cr-seats">
        ${s.capacity == null
          ? `${s.registered_count ?? 0} enrolled`
          : `${s.registered_count ?? 0} / ${s.capacity}`}
        ${s.waitlisted_count ? `<div class="tiny" style="color:var(--warn)">${plural(s.waitlisted_count, "waiting")}</div>` : ""}
        ${s.capacity != null
          ? `<span class="seatbar ${over ? "over" : s.is_full ? "full" : ""}"><i style="width:${pct}%"></i></span>` : ""}
      </span>
    </a>`;
  }).join("")}</div>`;
}
