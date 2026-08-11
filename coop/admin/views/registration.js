// =============================================================================
// Registration — the desk a family's paperwork lands on.
//
// Three facts and one act, per family:
//
//   Form      did they send it, and what did they write.  A fact, not a choice.
//   Reviewed  somebody has read it and is happy.          A toggle.
//   Payment   the money arrived, somewhere else.          A toggle.
//   Register  the act.
//
// The Register button is deliberately never disabled. A paper form handed in at
// church, a fee waived for a family having a hard year, a family registered at
// a meeting on a promise — all of these are real, and a system that refuses
// gets worked around, with the workaround being a spreadsheet nobody else can
// see. So it registers whenever asked, says plainly what is outstanding, and
// the database records what was outstanding at the time.
//
// Registration is what opens class sign-up. That is the whole reason this
// screen matters, and it says so at the top rather than making anybody infer it.
// =============================================================================

import { api } from "../../assets/api.js";
import {
  esc, $, $$, render, plural, relTime, fmtDate, toastOk, toastErr,
  formDialog, confirmDialog, modal,
} from "../../assets/ui.js";
import { REGISTRATION_STATUS } from "../../assets/proposal-fields.js";
import { refresh } from "../app.js";

const ORDER = ["not_started", "registered", "not_attending"];

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
  const waiting = rows.filter((r) => r.form_submitted_at && r.status !== "registered");

  const shown = filter === "waiting" ? waiting
    : filter === "no_form" ? rows.filter((r) => !r.form_submitted_at)
    : rows;

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
      <div class="stat"><span class="n">${rows.filter((r) => r.form_submitted_at).length}</span>
        <div class="l">Forms in</div></div>
    </div>

    <div class="note mt">
      <strong>Registering a family is what lets them sign up for classes.</strong>
      Until a family is registered here, its children cannot be given class
      places through the normal route — an administrator can still place a child
      by hand from the class page when something unusual comes up.
    </div>

    <div class="btn-row mt">
      ${[["all", `Everybody (${rows.length})`],
         ["waiting", `Forms to read (${waiting.length})`],
         ["no_form", `No form yet (${rows.filter((r) => !r.form_submitted_at).length})`]]
        .map(([k, label]) => `<a class="btn btn-sm ${filter === k ? "btn-primary" : ""}"
          href="#/registration?semester=${esc(semester.id)}&show=${k}">${esc(label)}</a>`).join("")}
      <div class="spacer"></div>
      <button class="btn btn-sm" id="bulk-review" ${
        waiting.length ? "" : "disabled"}>Mark all read</button>
    </div>

    ${shown.length ? `<div class="cards mt">${shown.map(block).join("")}</div>`
      : `<div class="empty"><h3>Nothing here</h3>
         <p>No families match this filter.</p></div>`}
  </div>`);

  const picker = $("#sem", app);
  if (picker) picker.addEventListener("change", () => {
    location.hash = `#/registration?semester=${picker.value}`;
  });

  $$("[data-act]", app).forEach((b) => b.addEventListener("click", () =>
    act(b.dataset.act, rows.find((r) => r.family_id === b.dataset.family), semester)));

  $("#bulk-review", app)?.addEventListener("click", () => bulkReview(waiting, semester));
}

// -----------------------------------------------------------------------------
// One family
// -----------------------------------------------------------------------------
function block(r) {
  const [label, cls] = REGISTRATION_STATUS[r.status] ?? ["Not started", ""];
  const registered = r.status === "registered";

  // What was missing when somebody registered them, if anything. Worth showing
  // because it is the answer to "why is this marked paid when it isn't".
  const outstanding = Array.isArray(r.outstanding_at_registration)
    ? r.outstanding_at_registration : [];

  return `<div class="card regblock">
    <div class="card-head">
      <div>
        <h3><a href="#/families/${esc(r.family_id)}">${esc(r.display_name)}</a></h3>
        <div class="sub">${plural(r.children, "child", "children")}${
          r.primary_email ? ` · ${esc(r.primary_email)}` : ""}</div>
      </div>
      <span class="badge ${cls}">${esc(label)}</span>
    </div>

    <div class="checks">
      <div class="checkrow">
        <span class="ck ${r.form_submitted_at ? "on" : ""}">${r.form_submitted_at ? "✓" : "○"}</span>
        <div class="ck-l"><strong>Form</strong>
          <div class="muted tiny">${r.form_submitted_at
            ? `received ${esc(fmtDate(r.form_submitted_at))}`
            : "not received"}</div></div>
        ${r.form_submitted_at
          ? `<button class="btn btn-sm" data-act="read" data-family="${esc(r.family_id)}">Read it</button>`
          : ""}
      </div>

      <div class="checkrow">
        <span class="ck ${r.reviewed_at ? "on" : ""}">${r.reviewed_at ? "✓" : "○"}</span>
        <div class="ck-l"><strong>Reviewed</strong>
          <div class="muted tiny">${r.reviewed_at
            ? `read ${esc(relTime(r.reviewed_at))}` : "not yet"}</div></div>
        <button class="btn btn-sm" data-act="review" data-family="${esc(r.family_id)}">
          ${r.reviewed_at ? "Undo" : "Mark read"}</button>
      </div>

      <div class="checkrow">
        <span class="ck ${r.payment_received_at ? "on" : ""}">${r.payment_received_at ? "✓" : "○"}</span>
        <div class="ck-l"><strong>Payment</strong>
          <div class="muted tiny">${r.payment_received_at
            ? `received ${esc(fmtDate(r.payment_received_at))}${
                r.payment_note ? ` · ${esc(r.payment_note)}` : ""}`
            : "not received"}</div></div>
        <button class="btn btn-sm" data-act="payment" data-family="${esc(r.family_id)}">
          ${r.payment_received_at ? "Undo" : "Mark received"}</button>
      </div>
    </div>

    ${registered && outstanding.length ? `<div class="note note-warn mt">
      Registered with ${esc(outstanding.join(" and "))} still outstanding
      ${r.registered_at ? `on ${esc(fmtDate(r.registered_at))}` : ""}.</div>` : ""}

    ${r.note ? `<div class="muted tiny mt">Note: ${esc(r.note)}</div>` : ""}

    <div class="btn-row mt">
      ${registered
        ? `<button class="btn btn-sm" data-act="unregister" data-family="${esc(r.family_id)}">
             Undo registration</button>`
        : `<button class="btn btn-primary btn-sm" data-act="register" data-family="${esc(r.family_id)}">
             Register this family</button>`}
      <button class="btn btn-sm" data-act="status" data-family="${esc(r.family_id)}">
        Set status…</button>
    </div>
  </div>`;
}

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------
async function act(what, r, semester) {
  if (!r) return;
  try {
    if (what === "read") return readForm(r, semester);

    if (what === "review") {
      await api.setRegistrationReview(r.family_id, semester.id, !r.reviewed_at);
      toastOk(r.reviewed_at ? "No longer marked read." : "Marked read.");
    }

    if (what === "payment") {
      if (r.payment_received_at) {
        await api.setRegistrationPayment(r.family_id, semester.id, false, null);
        toastOk("No longer marked received.");
      } else {
        const a = await formDialog({
          title: `Payment from ${r.display_name}`,
          submitLabel: "Mark received",
          fields: [{ name: "note", label: "Note", type: "textarea",
            hint: "Optional. “Cash at the August meeting”, “fee waived this term”." }],
        });
        if (!a) return;
        await api.setRegistrationPayment(r.family_id, semester.id, true, a.note);
        toastOk("Payment marked received.");
      }
    }

    if (what === "register") {
      const missing = [
        !r.form_submitted_at ? "no form has been received" : "",
        !r.reviewed_at ? "it has not been marked read" : "",
        !r.payment_received_at ? "payment has not been marked received" : "",
      ].filter(Boolean);

      // Never a refusal — a warning that names what is missing, and then does
      // as it is told.
      if (missing.length) {
        const ok = await confirmDialog(
          `Register ${r.display_name}?`,
          `This family will be registered even though ${missing.join(", and ")}. ` +
          "That is allowed, and what was outstanding is recorded. They will be " +
          "able to sign up for classes.",
          "Register anyway");
        if (!ok) return;
      }

      const res = await api.registerFamily(r.family_id, semester.id);
      toastOk(res?.outstanding?.length
        ? `${r.display_name} registered, with ${res.outstanding.join(" and ")} outstanding.`
        : `${r.display_name} registered.`);
    }

    if (what === "unregister") {
      const ok = await confirmDialog(
        `Undo registration for ${r.display_name}?`,
        "They will no longer be able to sign up for classes. Any class places " +
        "already given are not affected.",
        "Undo it", true);
      if (!ok) return;
      await api.setFamilyRegistration(r.family_id, semester.id, "not_started", r.note);
      toastOk("Registration undone.");
    }

    if (what === "status") {
      const a = await formDialog({
        title: r.display_name,
        submitLabel: "Save",
        fields: [
          { name: "status", label: `Taking part in ${semester.name}?`, type: "select",
            value: r.status,
            options: ORDER.map((s) => ({ value: s, label: REGISTRATION_STATUS[s][0] })) },
          { name: "note", label: "Note", type: "textarea", value: r.note ?? "",
            hint: "Only administrators see this." },
        ],
      });
      if (!a) return;
      await api.setFamilyRegistration(r.family_id, semester.id, a.status, a.note);
      toastOk("Saved.");
    }

    await refresh();
  } catch (e) {
    toastErr(e.message);
  }
}

/** What the family actually wrote, question by question. */
function readForm(r, semester) {
  const d = r.form_data ?? {};
  const row = (q, a) => `<div class="qa">
    <div class="q">${esc(q)}</div>
    <div class="a">${a ? esc(a) : `<span class="faint">Left blank</span>`}</div>
  </div>`;

  const grades = [...(d.grades ?? []), ...(d.new_children ?? [])]
    .map((g) => g.grade).filter(Boolean).join(", ");

  modal({
    title: `${r.display_name} — ${semester.name}`,
    wide: true,
    body: `
      <div class="sub mb">Sent ${esc(fmtDate(r.form_submitted_at))}</div>
      ${row("Code of Conduct agreed", d.agreed_conduct ? "Yes" : "No")}
      ${row("Phone", d.primary_phone)}
      ${row("Grades given", grades)}
      ${(d.new_children ?? []).length ? row("Children added",
        d.new_children.map((c) =>
          `${c.first_name} ${c.last_name ?? ""}`.trim() +
          (c.birth_date ? ` (born ${c.birth_date})` : "")).join("; ")) : ""}
      ${(d.new_parents ?? []).length ? row("Parents added",
        d.new_parents.map((p) => `${p.first_name} ${p.last_name ?? ""}`.trim()).join("; ")) : ""}
      ${row("Additional comments, including known absences", d.comments)}

      ${d.comments ? `<div class="note mt">
        If they have named dates here, record those absences yourself under
        <a href="#/absences">Absences</a> — nothing reads this text.</div>` : ""}`,
    buttons: [{ value: null, label: "Close" }],
  });
}

async function bulkReview(waiting, semester) {
  const ok = await confirmDialog(
    "Mark every waiting form as read?",
    `${plural(waiting.length, "form")} will be marked read. This does not ` +
    "register anybody — you still press Register on each family.",
    "Mark them read");
  if (!ok) return;

  let done = 0;
  for (const r of waiting) {
    try {
      await api.setRegistrationReview(r.family_id, semester.id, true);
      done++;
    } catch { /* keep going; the rest should not fail because one did */ }
  }
  toastOk(`${plural(done, "form")} marked read.`);
  await refresh();
}
