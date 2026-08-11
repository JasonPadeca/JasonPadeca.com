// =============================================================================
// Registering for a semester, from the family's side.
//
// The old form asked a mother of seven to type seven children's names, their
// grades, her own name, her email and her phone number, every August, into a
// form somebody then read by hand against records that already held all of it.
//
// So this form starts from what is on file and asks only what changes. Fields
// the co-op already has are filled in and labelled as needing attention "only
// if this is your first semester or it has changed" — a parent can read down
// the page, see their own details are right, put a grade against each child and
// be done in under a minute.
//
// A family whose record is empty — approved to join but never described — gets
// the fuller form, because for them nothing is on file yet. That is the same
// form, with the blanks showing.
// =============================================================================

import { api } from "../assets/api.js";
import { esc, $, $$, render, fmtDate, toastOk, toastErr } from "../assets/ui.js";

// Shown against anything the co-op already holds. Consistent wording, because
// a parent should learn the phrase once and then skim it.
const IF_CHANGED = "Only needed if this is your first semester or it has changed";

const CONDUCT_URL = "../about-koinonia-faq/";

let payload = null;
let onDone = null;

export async function render_(el, opts = {}) {
  onDone = opts.onChange ?? (() => {});
  try {
    payload = await api.registrationForm();
  } catch (e) {
    return render(el, `<div class="card">
      <div class="card-head"><h3>Registration</h3></div>
      <div class="note note-danger">${esc(e.message)}</div></div>`);
  }
  draw(el);
}

function draw(el) {
  if (!payload?.ok) {
    return render(el, `<div class="card">
      <div class="card-head"><h3>Registration</h3></div>
      <p class="muted">${payload?.error === "no_family"
        ? "There is no family record for your address yet. An administrator can set one up."
        : "Registration is not available just now."}</p></div>`);
  }

  if (!payload.semester) {
    return render(el, `<div class="card">
      <div class="card-head"><h3>Registration</h3></div>
      <p class="muted">Registration is not open at the moment. You will get an
        email when it opens for the next semester.</p></div>`);
  }

  if (payload.submitted) return drawSubmitted(el);
  drawForm(el);
}

// -----------------------------------------------------------------------------
// Already sent
// -----------------------------------------------------------------------------
function drawSubmitted(el) {
  const s = payload.submitted;
  const registered = s.status === "registered";

  render(el, `<div class="card">
    <div class="card-head"><h3>${esc(payload.semester.name)} registration</h3></div>

    <div class="note ${registered ? "note-ok" : ""}">
      <strong>${registered
        ? "You are registered for this semester."
        : "Your registration has been sent."}</strong>
      <div class="mt">Sent ${esc(fmtDate(s.at))}.
        ${registered
          ? "Class sign-up opens separately — you will get an email."
          : "It is waiting to be looked at. Nothing more is needed from you " +
            "here; if a payment is outstanding, the co-op will be in touch."}</div>
    </div>

    <div class="btn-row mt">
      <button class="btn" id="again">Send it again</button>
      <span class="muted">If something you sent was wrong.</span>
    </div>
  </div>`);

  $("#again", el).addEventListener("click", () => {
    payload.submitted = null;
    drawForm(el);
  });
}

// -----------------------------------------------------------------------------
// The form
// -----------------------------------------------------------------------------
function drawForm(el) {
  const first = payload.first_semester;
  const closes = payload.semester.closes_at;

  render(el, `<div class="card">
    <div class="card-head"><h3>Register for ${esc(payload.semester.name)}</h3></div>

    ${closes ? `<p class="muted">Registration closes ${esc(fmtDate(closes))}.</p>` : ""}

    ${first ? `<div class="note">
      <strong>Welcome.</strong> Because this is your family's first semester, we
      need a few details we do not have yet. Next time this page will already
      know most of it.</div>` : `<div class="note">
      <strong>Most of this is already filled in.</strong> Check it over, put a
      grade against each child, and send it. Anything marked
      <em>${esc(IF_CHANGED.toLowerCase())}</em> can be left alone if it is still
      right.</div>`}

    <h4 class="mt2">Your family</h4>
    <div class="field">
      <label for="primary_phone">Phone number</label>
      <input type="tel" id="primary_phone" value="${esc(payload.family.primary_phone ?? "")}">
      <div class="hint">${esc(IF_CHANGED)}.</div>
    </div>

    ${payload.parents.length ? `
      <div class="field">
        <label>Parents on file</label>
        <div class="onfile">${payload.parents.map((p) => `
          <div class="onfile-row">
            <strong>${esc(p.first_name)} ${esc(p.last_name ?? "")}</strong>
            ${p.email ? `<span class="muted">${esc(p.email)}</span>` : ""}
            ${p.phone ? `<span class="muted">${esc(p.phone)}</span>` : ""}
          </div>`).join("")}</div>
        <div class="hint">If any of this is wrong, tell the registrar — it
          cannot be changed here.</div>
      </div>`
    : `<div id="new-parents"></div>`}

    <h4 class="mt2">Children</h4>
    ${payload.children.length ? `
      <p class="muted">Put this semester's grade against each child.</p>
      <div class="kids">${payload.children.map(knownChild).join("")}</div>`
    : ""}

    <div id="new-children"></div>
    <div class="btn-row mt">
      <button class="btn btn-sm" id="add-child">Add a child</button>
    </div>

    <h4 class="mt2">Code of Conduct</h4>
    <label class="check mt">
      <input type="checkbox" id="agreed_conduct">
      <span>I and my family have read and agree to abide by Koinonia Homeschool
        Group's <a href="${CONDUCT_URL}" target="_blank" rel="noopener">Code of
        Conduct</a>.</span>
    </label>

    <h4 class="mt2">Anything else</h4>
    <div class="field">
      <label for="comments">Additional comments</label>
      <textarea id="comments" rows="4"></textarea>
      <div class="hint">Please include any absences you already know about for
        this semester.</div>
    </div>

    <div class="btn-row mt2">
      <button class="btn btn-primary" id="send">Send registration</button>
      <span class="muted" id="send-state"></span>
    </div>
  </div>`);

  // A family with nobody on file is asked who the parents are — the same
  // question an administrator would otherwise type in from an email.
  if (!payload.parents.length) {
    render($("#new-parents", el), `
      <p class="muted">We do not have any parents on file for your family yet.</p>
      ${[0, 1].map(newParentRow).join("")}`);
  }

  // A first-semester family starts with one blank child rather than none, so
  // the shape of what is being asked is visible without pressing anything.
  if (!payload.children.length) addChild(el);

  $("#add-child", el).addEventListener("click", () => addChild(el));
  $("#send", el).addEventListener("click", () => send(el));
}

function knownChild(c) {
  return `<div class="kid" data-child="${esc(c.id)}">
    <div class="kid-name">
      <strong>${esc(c.first_name)} ${esc(c.last_name ?? "")}</strong>
      ${c.birth_date ? `<span class="muted tiny">born ${esc(fmtDate(c.birth_date))}</span>` : ""}
    </div>
    <div class="field">
      <label for="grade-${esc(c.id)}">Grade</label>
      <input type="text" id="grade-${esc(c.id)}" class="grade"
             value="${esc(c.grade ?? "")}" placeholder="e.g. 4th">
    </div>
  </div>`;
}

function newParentRow(i) {
  return `<div class="newrow new-parent">
    <div class="field"><label>Parent ${i + 1} name</label>
      <input type="text" class="np-first" placeholder="First name"></div>
    <div class="field"><label>Last name</label>
      <input type="text" class="np-last"></div>
    <div class="field"><label>Email</label>
      <input type="email" class="np-email"></div>
    <div class="field"><label>Phone</label>
      <input type="tel" class="np-phone"></div>
  </div>`;
}

function addChild(el) {
  const host = $("#new-children", el);
  const row = document.createElement("div");
  row.className = "newrow new-child";
  row.innerHTML = `
    <div class="field"><label>Child's name</label>
      <input type="text" class="nc-first" placeholder="First name"></div>
    <div class="field"><label>Last name</label>
      <input type="text" class="nc-last"
             value="${esc(payload.family.display_name?.replace(/ Family$/, "") ?? "")}"></div>
    <div class="field"><label>Date of birth</label>
      <input type="date" class="nc-dob"></div>
    <div class="field"><label>Grade</label>
      <input type="text" class="nc-grade" placeholder="e.g. 4th"></div>
    <button class="btn btn-sm btn-ghost nc-remove" type="button">Remove</button>`;
  host.appendChild(row);
  row.querySelector(".nc-remove").addEventListener("click", () => row.remove());
}

async function send(el) {
  const body = {
    semester_id: payload.semester.id,
    primary_phone: $("#primary_phone", el).value.trim(),
    agreed_conduct: $("#agreed_conduct", el).checked,
    comments: $("#comments", el).value.trim(),
    grades: $$(".kid", el).map((k) => ({
      child_id: k.dataset.child,
      grade: $(".grade", k).value.trim(),
    })),
    new_parents: $$(".new-parent", el).map((r) => ({
      first_name: $(".np-first", r).value.trim(),
      last_name: $(".np-last", r).value.trim(),
      email: $(".np-email", r).value.trim(),
      phone: $(".np-phone", r).value.trim(),
    })).filter((p) => p.first_name),
    new_children: $$(".new-child", el).map((r) => ({
      first_name: $(".nc-first", r).value.trim(),
      last_name: $(".nc-last", r).value.trim(),
      birth_date: $(".nc-dob", r).value,
      grade: $(".nc-grade", r).value.trim(),
    })).filter((c) => c.first_name),
  };

  if (!body.agreed_conduct) {
    toastErr("The Code of Conduct has to be agreed to before registering.");
    $("#agreed_conduct", el).focus();
    return;
  }
  if (!payload.children.length && !body.new_children.length) {
    toastErr("Add at least one child.");
    return;
  }

  const btn = $("#send", el);
  const state = $("#send-state", el);
  btn.disabled = true;
  state.textContent = "Sending…";

  try {
    const res = await api.submitRegistrationForm(body);
    if (!res?.ok) throw new Error(explain(res?.error));
    toastOk("Registration sent.");
    payload = await api.registrationForm();
    draw(el);
    onDone();
  } catch (e) {
    btn.disabled = false;
    state.textContent = "";
    toastErr(e.message);
  }
}

function explain(code) {
  return {
    registration_closed: "Registration has closed for this semester.",
    conduct_required: "The Code of Conduct has to be agreed to before registering.",
    no_semester: "That semester no longer exists.",
    no_family: "There is no family record for your address.",
  }[code] ?? "The registration could not be sent.";
}
