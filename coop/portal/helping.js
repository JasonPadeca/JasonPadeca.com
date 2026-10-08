// =============================================================================
// "Which classes would you help with?"
//
// Laid out like the class sign-up page on purpose: periods down the page,
// classes within each, tick what you would take. A parent who has done sign-up
// once already knows how to read this, and the co-op's whole year runs on
// people recognising a shape rather than learning one.
//
// What this is NOT is a booking. A parent ticking four classes has not
// committed to four classes — they have told the leadership what they would be
// willing to do, and a person decides from there. The page says so, because
// "would you help?" and "you are now teaching this" are very different
// promises and the difference should not depend on somebody's assumption.
// =============================================================================

import { api } from "../assets/api.js";
import { esc, $, $$, render, toastOk, toastErr, plural } from "../assets/ui.js";

let data = null;

export async function render_(el) {
  try {
    data = await api.helperForm();
  } catch (e) {
    return render(el, `<div class="card">
      <div class="card-head"><h3>Helping with classes</h3></div>
      <div class="note note-danger">${esc(e.message)}</div>
      <p class="muted mt">If this says the function does not exist, the database
      update that adds it has not been run yet.</p></div>`);
  }
  draw(el);
}

function draw(el) {
  if (!data?.ok) {
    return render(el, `<div class="card">
      <div class="card-head"><h3>Helping with classes</h3></div>
      <p class="muted">${data?.error === "no_semester"
        ? "There is no semester open at the moment."
        : "There is no family record for your address yet."}</p></div>`);
  }

  const parents = data.parents ?? [];
  if (!parents.length) {
    return render(el, `<div class="card">
      <div class="card-head"><h3>Helping with classes</h3></div>
      <p class="muted">There are no parents on your family record yet. An
        administrator can add them, or you can under Your family.</p></div>`);
  }

  render(el, `<div class="card">
    <div class="card-head"><h3>Helping with ${esc(data.semester.name)}</h3></div>

    <p class="muted">Every class runs on parents helping. Tick anything you
      would be willing to take — you are not signing up for all of them. The
      leadership works out who goes where and will tell you.</p>

    ${parents.length > 1 ? `<div class="field mt">
      <label for="who">Who is this for?</label>
      <select id="who">${parents.map((p, i) =>
        `<option value="${esc(p.id)}" ${i ? "" : "selected"}>${esc(p.name)}</option>`
      ).join("")}</select>
    </div>` : ""}

    <div id="helper-body"></div>
  </div>`);

  const pick = $("#who", el);
  const current = () => pick ? pick.value : parents[0].id;
  if (pick) pick.addEventListener("change", () => drawFor(el, current()));
  drawFor(el, current());
}

function drawFor(el, parentId) {
  const p = (data.parents ?? []).find((x) => x.id === parentId);
  if (!p) return;

  const wants = new Set((p.wants ?? []).map(String));
  const assigned = p.assigned ?? [];

  render($("#helper-body", el), `
    ${assigned.length ? `<div class="note note-ok mt">
      <strong>${esc(p.name)} is down to help with:</strong>
      ${assigned.map((a) => `<div class="mt">
        <strong>${esc(a.class)}</strong> <span class="muted">— ${esc(a.period)}</span>
      </div>`).join("")}
      <div class="tiny mt">Ticking below changes what you are offering, not
        what you have been given. Speak to the registrar to change a placement.</div>
    </div>` : ""}

    ${(data.periods ?? []).map((per) => `
      <h4 class="mt2">${esc(per.name)}
        <span class="muted tiny">${esc(per.start_time ?? "")}${
          per.end_time ? `–${esc(per.end_time)}` : ""}</span></h4>
      ${per.classes.length ? `<div class="helper-classes">
        ${per.classes.map((c) => {
          const full = c.helpers_have >= c.helpers_wanted && c.helpers_wanted > 0;
          return `<label class="helper-class ${wants.has(String(c.id)) ? "is-on" : ""}">
            <input type="checkbox" data-class="${esc(c.id)}"
                   ${wants.has(String(c.id)) ? "checked" : ""}>
            <span class="hc-body">
              <strong>${esc(c.name)}</strong>
              ${c.age_min != null || c.age_max != null
                ? `<span class="muted tiny"> ages ${c.age_min ?? "any"}–${c.age_max ?? "any"}</span>`
                : ""}
              <span class="hc-need ${full ? "is-full" : ""}">
                ${c.helpers_have}/${c.helpers_wanted} helpers</span>
              ${c.description ? `<span class="tiny muted hc-desc">${esc(c.description)}</span>` : ""}
            </span>
          </label>`;
        }).join("")}
      </div>` : `<p class="muted">No classes in this period yet.</p>`}
    `).join("")}

    <div class="field mt2">
      <label for="hnote">Anything we should know?</label>
      <textarea id="hnote" rows="3"
        placeholder="Mornings are easier · happy to help but not to lead · I'll have the baby with me"
      >${esc(p.note ?? "")}</textarea>
    </div>

    <div class="btn-row mt">
      <button class="btn btn-primary" id="hsave">Send this</button>
      <span class="muted" id="hstate">${p.note != null || wants.size
        ? "You have answered before — sending again replaces it." : ""}</span>
    </div>`);

  $$(".helper-class input", el).forEach((cb) =>
    cb.addEventListener("change", () =>
      cb.closest(".helper-class").classList.toggle("is-on", cb.checked)));

  $("#hsave", el).addEventListener("click", () => save(el, parentId));
}

async function save(el, parentId) {
  const btn = $("#hsave", el);
  const state = $("#hstate", el);
  const classIds = $$(".helper-class input", el)
    .filter((cb) => cb.checked).map((cb) => cb.dataset.class);

  btn.disabled = true;
  state.textContent = "Sending…";
  try {
    const res = await api.submitHelperInterest({
      parent_id: parentId,
      semester_id: data.semester.id,
      class_ids: classIds,
      note: $("#hnote", el).value.trim(),
    });
    if (!res?.ok) throw new Error(res?.error === "not_your_family"
      ? "That is not somebody on your family record." : "Could not send that.");
    toastOk(classIds.length
      ? `Thank you — ${plural(classIds.length, "class")} noted.`
      : "Noted: not this semester.");
    data = await api.helperForm();
    draw(el);
  } catch (e) {
    btn.disabled = false;
    state.textContent = "";
    toastErr(e.message);
  }
}
