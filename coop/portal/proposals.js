// =============================================================================
// Proposing a class, from the family's side.
//
// One page for both kinds of proposal, because from a parent's chair there is
// only one thing happening: somebody in this house has an idea for a class. Who
// that somebody is decides which questions follow — a parent is offering to
// teach, a student is asking for something to be taught — but making them
// choose between two links first would be asking them to know that distinction
// before they have thought about it.
//
// So: pick a person, answer the questions that person is asked. Choosing a
// child swaps the form and nothing else.
// =============================================================================

import { api } from "../assets/api.js";
import { esc, $, $$, render, fmtDate, toastOk, toastErr, plural } from "../assets/ui.js";
import { fieldsFor } from "../assets/proposal-fields.js";

let payload = null;
let onDone = null;

export async function render_(el, opts = {}) {
  onDone = opts.onChange ?? (() => {});
  try {
    payload = await api.proposalPayload();
  } catch (e) {
    return render(el, `<div class="card">
      <div class="card-head"><h3>Propose a class</h3></div>
      <div class="note note-danger">${esc(e.message)}</div></div>`);
  }
  draw(el);
}

function draw(el) {
  const people = [
    ...payload.parents.map((p) => ({ ...p, kind: "parent" })),
    ...payload.children.map((c) => ({ ...c, kind: "student" })),
  ];
  const mine = payload.mine ?? [];

  render(el, `<div class="card">
    <div class="card-head">
      <h3>Propose a class</h3>
      ${mine.length ? `<span class="muted">${plural(mine.length, "sent")}</span>` : ""}
    </div>

    ${mine.length ? `<div class="table-scroll mt"><table>
      <thead><tr><th>Class</th><th>Proposed by</th><th>Sent</th><th>Status</th></tr></thead>
      <tbody>${mine.map(sentRow).join("")}</tbody></table></div>` : ""}

    ${people.length ? `
      <p class="muted mt">Anyone in your family can suggest a class — a parent
        offering to teach one, or a student asking for one. Choose who is
        proposing and the right questions will follow.</p>

      <div class="field mt">
        <label for="proposer">Who is proposing?</label>
        <select id="proposer">
          <option value="">Choose a person…</option>
          <optgroup label="Parents">
            ${payload.parents.map((p) =>
              `<option value="parent:${esc(p.id)}">${esc(p.name)}</option>`).join("")}
          </optgroup>
          ${payload.children.length ? `<optgroup label="Students">
            ${payload.children.map((c) =>
              `<option value="student:${esc(c.id)}">${esc(c.name)}</option>`).join("")}
          </optgroup>` : ""}
        </select>
      </div>

      <div id="proposal-form"></div>`
    : `<p class="muted mt">There is nobody on your family record who could
       propose a class yet. An administrator can add parents and children.</p>`}
  </div>`);

  const picker = $("#proposer", el);
  if (picker) {
    picker.addEventListener("change", () => drawForm(el, picker.value));
  }
}

function sentRow(p) {
  const state = p.status === "archived"
    ? (p.outcome === "accepted" ? `<span class="badge badge-ok">Accepted</span>`
      : p.outcome === "declined" ? `<span class="badge">Not this time</span>`
      : `<span class="badge">Considered</span>`)
    : `<span class="badge badge-warn">Waiting to be discussed</span>`;

  return `<tr>
    <td><strong>${esc(p.title)}</strong></td>
    <td>${esc(p.proposer ?? "—")}</td>
    <td class="mono">${esc(fmtDate(p.submitted_at))}</td>
    <td>${state}</td>
  </tr>`;
}

function drawForm(el, value) {
  const host = $("#proposal-form", el);
  if (!value) return render(host, "");

  const [kind, id] = value.split(":");
  const fields = fieldsFor(kind);
  const person = (kind === "parent" ? payload.parents : payload.children)
    .find((p) => p.id === id);

  render(host, `
    <div class="note mt">
      ${kind === "parent"
        ? `<strong>${esc(person?.name ?? "")} is offering to teach a class.</strong>
           These are the questions the leadership needs answered before they can
           work out whether the co-op can host it.`
        : `<strong>${esc(person?.name ?? "")} is asking for a class.</strong>
           A student proposal does not commit anybody to teaching it — it tells
           the leadership what the students would like to learn.`}
    </div>

    ${payload.semesters.length ? `<div class="field mt">
      <label for="semester_id">Which semester is this for?</label>
      <select id="semester_id" name="semester_id">
        <option value="">Not sure yet</option>
        ${payload.semesters.map((s) =>
          `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("")}
      </select>
    </div>` : ""}

    ${fields.map(fieldHtml).join("")}

    <div class="btn-row mt">
      <button class="btn btn-primary" id="send">Send this proposal</button>
      <span class="muted" id="send-state"></span>
    </div>`);

  $("#send", host).addEventListener("click", () => send(el, host, kind, id, fields));
}

function fieldHtml(f) {
  const id = `f-${f.name}`;
  const req = f.required ? ` <span class="req">required</span>` : "";
  const input =
    f.type === "textarea"
      ? `<textarea id="${id}" name="${esc(f.name)}" rows="4"></textarea>`
      : f.type === "select"
        ? `<select id="${id}" name="${esc(f.name)}">
             <option value="">Select one option</option>
             ${f.options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("")}
           </select>`
        : `<input type="${esc(f.type ?? "text")}" id="${id}" name="${esc(f.name)}">`;

  return `<div class="field mt">
    <label for="${id}">${esc(f.label)}${req}</label>
    ${input}
    ${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ""}
  </div>`;
}

async function send(el, host, kind, id, fields) {
  const body = {};
  for (const f of fields) {
    const node = $(`[name="${f.name}"]`, host);
    body[f.name] = (node?.value ?? "").trim();
  }
  body.semester_id = $('[name="semester_id"]', host)?.value || null;
  body[kind === "parent" ? "parent_id" : "child_id"] = id;

  // Checked here so somebody does not lose a long answer to a round trip, and
  // again in the database, which is what actually decides.
  const missing = fields.filter((f) => f.required && !body[f.name]);
  if (missing.length) {
    toastErr(`Still needed: ${missing.map((f) => f.label.replace(/\?$/, "")).join("; ")}`);
    const first = $(`[name="${missing[0].name}"]`, host);
    first?.focus();
    first?.scrollIntoView({ block: "center", behavior: "smooth" });
    return;
  }

  const btn = $("#send", host);
  const state = $("#send-state", host);
  btn.disabled = true;
  state.textContent = "Sending…";

  try {
    const res = await api.submitProposal(body);
    if (!res?.ok) throw new Error(explain(res?.error));
    toastOk("Sent. The leadership will read it before the next planning meeting.");
    payload = await api.proposalPayload();
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
    not_your_family: "That person is not on your family record.",
    no_proposer: "Choose who is proposing first.",
    title_required: "The class needs a title.",
  }[code] ?? "The proposal could not be sent.";
}
