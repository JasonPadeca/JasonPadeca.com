// =============================================================================
// Registration — which families are taking part this semester.
//
// This is the step between being a member of the co-op and having children in
// classes. A family applies once, ever; then every semester it says whether it
// is coming back; then its children are signed up for classes. Those are three
// different things and the software used to call the third one "registration",
// which is not what anybody in the co-op means by the word.
//
// The registrar sets this by hand for now. Whatever the eventual process turns
// out to be — a form, a fee, a signed agreement — it will write to this same
// record, and until it exists the honest thing is a screen that lets her mark
// what she already knows.
//
// Families with no record at all are listed too, as "not started". The question
// this page answers is "who have we not heard from", and a list that quietly
// omits them cannot answer it.
// =============================================================================

import { api } from "../../assets/api.js";
import {
  esc, $, $$, render, plural, relTime, toastOk, toastErr, formDialog,
} from "../../assets/ui.js";
import { REGISTRATION_STATUS } from "../../assets/proposal-fields.js";
import { refresh } from "../app.js";

const ORDER = ["not_started", "registered", "not_attending"];

export async function show(app, params) {
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

  if (!semester) {
    return render(app, `<div class="wrap page"><div class="empty">
      <h3>No semesters yet</h3>
      <p>Create one under <a href="#/semesters">Semesters</a> first.</p>
    </div></div>`);
  }

  let rows = [];
  try {
    rows = await api.registrationReport(semester.id);
  } catch (e) {
    return render(app, `<div class="wrap page">
      <div class="note note-danger">${esc(e.message)}</div>
      <p class="muted mt">If this says the function does not exist, the database
      update that adds it has not been run yet.</p></div>`);
  }

  const count = (s) => rows.filter((r) => r.status === s).length;

  render(app, `<div class="wrap page">
    <div class="page-head">
      <div>
        <h1>Registration</h1>
        <div class="sub">Which families are taking part in ${esc(semester.name)}</div>
      </div>
      ${semesters.length > 1 ? `<div class="btn-row">
        <select id="sem">
          ${semesters.map((s) => `<option value="${esc(s.id)}"
            ${s.id === semester.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}
        </select>
      </div>` : ""}
    </div>

    <div class="stats">
      ${ORDER.map((s) => `<div class="stat ${
        s === "not_started" && count(s) ? "attn" : ""}">
        <span class="n">${count(s)}</span>
        <div class="l">${esc(REGISTRATION_STATUS[s][0])}</div>
      </div>`).join("")}
    </div>

    <div class="note mt">
      This is a family saying it is taking part this semester — not the same as
      signing children up for classes, which happens under
      <a href="#/enrollment">Class Sign-up</a>. Families you have not marked yet
      show as not started.
    </div>

    <div class="card mt">
      <div class="table-scroll"><table>
        <thead><tr>
          <th>Family</th><th class="num">Children</th><th>Status</th>
          <th>Note</th><th></th>
        </tr></thead>
        <tbody>${rows.map(row).join("")}</tbody>
      </table></div>
    </div>
  </div>`);

  const picker = $("#sem", app);
  if (picker) {
    picker.addEventListener("change", () => {
      location.hash = `#/registration?semester=${picker.value}`;
    });
  }

  $$("[data-set]", app).forEach((b) =>
    b.addEventListener("click", () => setOne(
      rows.find((r) => r.family_id === b.dataset.set), semester)));
}

function row(r) {
  const [label, cls] = REGISTRATION_STATUS[r.status] ?? ["Not started", ""];
  return `<tr>
    <td><a href="#/families/${esc(r.family_id)}"><strong>${esc(r.display_name)}</strong></a>
      ${r.primary_email ? `<div class="tiny muted">${esc(r.primary_email)}</div>` : ""}</td>
    <td class="num mono">${r.children}</td>
    <td><span class="badge ${cls}">${esc(label)}</span></td>
    <td>${r.note ? esc(r.note) : `<span class="faint">—</span>`}
      ${r.updated_at ? `<div class="tiny muted">${esc(relTime(r.updated_at))}</div>` : ""}</td>
    <td class="right"><button class="btn btn-sm" data-set="${esc(r.family_id)}">Change</button></td>
  </tr>`;
}

async function setOne(r, semester) {
  if (!r) return;

  const answers = await formDialog({
    title: r.display_name,
    submitLabel: "Save",
    fields: [
      { name: "status", label: `Taking part in ${semester.name}?`, type: "select",
        value: r.status,
        options: ORDER.map((s) => ({ value: s, label: REGISTRATION_STATUS[s][0] })) },
      { name: "note", label: "Note", type: "textarea", value: r.note ?? "",
        hint: "Optional, and only administrators see it. " +
              "“Paid at the August meeting”, “moving away in October”." },
    ],
  });
  if (!answers) return;

  try {
    const res = await api.setFamilyRegistration(
      r.family_id, semester.id, answers.status, answers.note);
    if (!res?.ok) throw new Error(res?.error ?? "Could not save that.");
    toastOk(`${r.display_name}: ${REGISTRATION_STATUS[answers.status][0].toLowerCase()}.`);
    await refresh();
  } catch (e) {
    toastErr(e.message);
  }
}
