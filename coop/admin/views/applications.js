// =============================================================================
// Applications (§2.5 — admission stays a human decision).
//
// The software's job here is to stop applications being lost in an inbox and to
// show what is outstanding. It does not score anybody, rank anybody, or suggest
// an answer. Whether a family is a fit for this co-op is a judgement the
// leadership makes by reading what they wrote, which is why the long answers are
// shown in full rather than truncated into a table.
//
// Approving creates the family record and nothing else. Parents and children are
// entered afterwards from the family page: "Sarah and Michael, kids are 7, 9 and
// 13" cannot be split into rows without guessing, and a child called "and" is a
// worse outcome than a minute of typing.
// =============================================================================

import { api } from "../../assets/api.js";
import {
  esc, $, render, fmtDate, toastOk, toastErr, plural,
  formDialog, confirmDialog, modal,
} from "../../assets/ui.js";
import { refresh, go } from "../app.js";

const STATUS = {
  submitted: ["New", "badge-warn"],
  in_review: ["Being read", ""],
  approved:  ["Approved", "badge-ok"],
  declined:  ["Declined", "badge-danger"],
  withdrawn: ["Withdrawn", ""],
};

export async function show(app) {
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const filter = params.get("status") ?? "open";

  let rows = [];
  try {
    rows = await api.applications();
  } catch (e) {
    return render(app, `<div class="wrap page">
      <div class="note note-danger">${esc(e.message)}</div></div>`);
  }

  const open = rows.filter((r) => r.status === "submitted" || r.status === "in_review");
  const shown = filter === "all" ? rows : open;

  render(app, `<div class="wrap page">
    <div class="page-head">
      <div>
        <h1>Applications</h1>
        <div class="sub">${plural(open.length, "application")} waiting${
          rows.length !== open.length ? ` · ${rows.length} in total` : ""}</div>
      </div>
      <div class="btn-row">
        <a class="btn" href="#/applications?status=${filter === "all" ? "open" : "all"}">
          ${filter === "all" ? "Only what is waiting" : "Show all"}</a>
      </div>
    </div>

    ${shown.length ? shown.map(card).join("")
      : `<div class="empty">
          <h3>${filter === "all" ? "No applications yet" : "Nothing waiting"}</h3>
          <p>${filter === "all"
            ? "Applications from the website will appear here."
            : "Every application has been dealt with."}</p>
        </div>`}
  </div>`);

  app.querySelectorAll("[data-open]").forEach((b) =>
    b.addEventListener("click", () => openOne(rows.find((r) => r.id === b.dataset.open))));
}

function card(r) {
  const [label, cls] = STATUS[r.status] ?? [r.status, ""];
  return `<div class="card">
    <div class="card-head" style="margin-bottom:.5rem">
      <div>
        <h3>${esc(r.parent_names)}</h3>
        <div class="small muted">${esc(r.email)}${r.phone ? ` · ${esc(r.phone)}` : ""}</div>
      </div>
      <span class="badge ${cls}">${esc(label)}</span>
    </div>
    <div class="small muted">Children: ${esc((r.children_text ?? "").replace(/\s+/g, " ").slice(0, 120))}${
      (r.children_text ?? "").length > 120 ? "…" : ""}</div>
    <div class="btn-row mt">
      <button class="btn btn-sm" data-open="${esc(r.id)}">Read it</button>
      ${r.family_id ? `<a class="btn btn-sm btn-ghost" href="#/families/${esc(r.family_id)}">
        Open the family</a>` : ""}
      <span class="tiny faint" style="align-self:center">
        Applied ${esc(fmtDate(r.created_at))}</span>
    </div>
  </div>`;
}

/**
 * The whole application, unabridged.
 *
 * Their answers are the entire basis for the decision, so they are shown as
 * written — no truncation, no summary, nothing collapsed behind a link.
 */
async function openOne(r) {
  if (!r) return;
  const [label] = STATUS[r.status] ?? [r.status];

  const answer = (q, a) => a
    ? `<div class="mt2"><div class="tiny faint">${esc(q)}</div>
       <div class="mt small" style="white-space:pre-wrap">${esc(a)}</div></div>`
    : "";

  const choice = await modal({
    title: r.parent_names,
    wide: true,
    body: `
      <div class="small muted">${esc(r.email)}${r.phone ? ` · ${esc(r.phone)}` : ""}
        · applied ${esc(fmtDate(r.created_at))} · <strong>${esc(label)}</strong></div>

      ${r.agrees_to_beliefs
        ? `<div class="note note-ok mt">Agreed to the Statement of Faith and Code of Conduct.</div>`
        : `<div class="note note-danger mt">Did NOT agree to the Statement of Faith
           and Code of Conduct.</div>`}

      ${answer("Children's names, ages, and grades", r.children_text)}
      ${answer("How they heard about Koinonia", r.heard_about)}
      ${answer("Their homeschool journey", r.homeschool_journey)}
      ${answer("About themselves", r.about_yourself)}
      ${answer("What they are looking for", r.looking_for)}
      ${r.admin_notes ? `<div class="note mt2"><strong>Notes:</strong>
        ${esc(r.admin_notes)}</div>` : ""}`,
    buttons: r.status === "approved"
      ? [{ value: null, label: "Close" }]
      : [
          { value: null, label: "Close" },
          { value: "note", label: "Add a note" },
          { value: "decline", label: "Decline", class: "btn-danger" },
          { value: "approve", label: "Approve", class: "btn-primary" },
        ],
  });

  if (!choice) return;

  if (choice === "note") {
    const v = await formDialog({
      title: "Note on this application",
      submitLabel: "Save",
      fields: [
        { name: "notes", label: "Notes", type: "textarea", value: r.admin_notes,
          hint: "Only administrators see this. The applicant never does." },
        { name: "status", label: "Status", type: "select", value: r.status,
          options: [{ value: "submitted", label: "New" },
                    { value: "in_review", label: "Being read" }] },
      ],
    });
    if (!v) return;
    try {
      await api.setApplicationStatus(r.id, v.status, v.notes);
      toastOk("Saved.");
      refresh();
    } catch (e) { toastErr(e.message); }
    return;
  }

  if (choice === "decline") {
    const ok = await confirmDialog("Decline this application?",
      `${r.parent_names} will not be added to the co-op. Nothing is sent to them automatically — telling a family no is a conversation, not an email from a database.`,
      "Decline", true);
    if (!ok) return;
    try {
      await api.setApplicationStatus(r.id, "declined");
      toastOk("Declined.");
      refresh();
    } catch (e) { toastErr(e.message); }
    return;
  }

  if (choice === "approve") {
    const v = await formDialog({
      title: `Approve ${r.parent_names}?`,
      submitLabel: "Approve and create the family",
      fields: [
        { name: "display_name", label: "Family name", required: true,
          value: guessFamilyName(r.parent_names),
          hint: "How they will appear throughout the app." },
      ],
    });
    if (!v) return;
    try {
      const res = await api.approveApplication(r.id, v.display_name);
      if (!res?.ok) return toastErr(res?.error ?? "Could not approve.");
      toastOk(`${res.display_name} created. Add their parents and children next.`);
      go(`#/families/${res.family_id}`);
    } catch (e) { toastErr(e.message); }
  }
}

/**
 * A first guess at the family name from "Sarah and Michael Thompson".
 *
 * Only ever a suggestion in an editable box — surnames do not follow a rule,
 * and a family whose name the co-op gets wrong on day one notices.
 */
function guessFamilyName(parentNames) {
  const last = String(parentNames ?? "").trim().split(/\s+/).pop();
  return last ? `${last} Family` : "";
}
