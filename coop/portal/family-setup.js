// =============================================================================
// Family setup — where a family keeps its own details right.
//
// This is the page that answers "we changed our phone number" and "Emma has
// developed a nut allergy" without an email to the registrar and a wait. The
// parents are the only people who actually know any of this; until now they
// were made to tell somebody else so that somebody else could type it in.
//
// It is a tab rather than a block on the front page. The front page is about
// this week — what is on, who is away — and a form for editing birth dates has
// no business sitting on top of it. But it does need a home, which is what the
// earlier version got wrong in the other direction by having none at all.
// =============================================================================

import { api } from "../assets/api.js";
import { esc, $, $$, render, ageAt, toastOk, toastErr } from "../assets/ui.js";

let data = null;
let volunteering = null;

export async function render_(el) {
  try {
    data = await api.familySetup();
    // Not fatal: this is a section of the page, not the page.
    volunteering = await api.familyVolunteering().catch(() => null);
  } catch (e) {
    return render(el, `<div class="card">
      <div class="card-head"><h3>Your family</h3></div>
      <div class="note note-danger">${esc(e.message)}</div>
      <p class="muted mt">If this says the function does not exist, the database
      update that adds it has not been run yet.</p></div>`);
  }
  draw(el);
}

function draw(el) {
  if (!data?.ok || !data.families?.length) {
    return render(el, `<div class="card">
      <div class="card-head"><h3>Your family</h3></div>
      <p class="muted">There is no family record for your address yet. An
        administrator can set one up.</p></div>`);
  }

  render(el, data.families.map(familyCard).join("") + volunteerCard());

  $$("[data-add-child]", el).forEach((b) =>
    b.addEventListener("click", () => addChild(el, b.dataset.addChild)));
  $$("[data-add-parent]", el).forEach((b) =>
    b.addEventListener("click", () => addParent(el, b.dataset.addParent)));
  $$("[data-save]", el).forEach((b) =>
    b.addEventListener("click", () => save(el, b.dataset.save)));
}

function familyCard(f) {
  return `<div class="card famcard" data-family="${esc(f.id)}">
    <div class="card-head"><h3>${esc(f.display_name)}</h3></div>

    <p class="muted">Keep this up to date and the co-op will always have the
      right way to reach you. Teachers see allergies and medical notes on their
      class lists.</p>

    <h4 class="mt2">How the co-op reaches your family</h4>
    <div class="grid grid-2">
      <div class="field">
        <label>Main email address</label>
        <input type="email" class="fam-email" value="${esc(f.primary_email ?? "")}">
        <div class="hint">This is the address you sign in with. Ask the
          registrar before changing it.</div>
      </div>
      <div class="field">
        <label>Main phone number</label>
        <input type="tel" class="fam-phone" value="${esc(f.primary_phone ?? "")}">
      </div>
    </div>

    <h4 class="mt2">Parents</h4>
    <div class="people parents">${f.parents.map(parentRow).join("")}</div>
    <div class="btn-row mt">
      <button class="btn btn-sm" data-add-parent="${esc(f.id)}">Add a parent</button>
    </div>

    <h4 class="mt2">Children</h4>
    ${f.children.length ? "" : `<p class="muted">Nobody yet.</p>`}
    <div class="people children">${f.children.map(childRow).join("")}</div>
    <div class="btn-row mt">
      <button class="btn btn-sm" data-add-child="${esc(f.id)}">Add a child</button>
    </div>

    <div class="note mt2">
      To take a child off the roll, or to change your family's name, ask the
      registrar — those affect past terms and are not editable here.
    </div>

    <div class="btn-row mt2">
      <button class="btn btn-primary" data-save="${esc(f.id)}">Save changes</button>
      <span class="muted save-state"></span>
    </div>
  </div>`;
}

function parentRow(p = {}) {
  return `<div class="person parent" ${p.id ? `data-id="${esc(p.id)}"` : ""}>
    <div class="field"><label>First name</label>
      <input type="text" class="p-first" value="${esc(p.first_name ?? "")}"></div>
    <div class="field"><label>Last name</label>
      <input type="text" class="p-last" value="${esc(p.last_name ?? "")}"></div>
    <div class="field"><label>Email</label>
      <input type="email" class="p-email" value="${esc(p.email ?? "")}"></div>
    <div class="field"><label>Phone</label>
      <input type="tel" class="p-phone" value="${esc(p.phone ?? "")}"></div>
  </div>`;
}

function childRow(c = {}) {
  const age = c.birth_date ? ageAt(c.birth_date, todayISO()) : null;

  return `<div class="person child" ${c.id ? `data-id="${esc(c.id)}"` : ""}>
    <div class="person-head">
      <strong>${c.first_name ? esc(c.first_name) : "New child"}</strong>
      ${age != null ? `<span class="muted tiny">${age} years old</span>` : ""}
    </div>

    <div class="field"><label>First name</label>
      <input type="text" class="c-first" value="${esc(c.first_name ?? "")}"></div>
    <div class="field"><label>Last name</label>
      <input type="text" class="c-last" value="${esc(c.last_name ?? "")}"></div>
    <div class="field"><label>Date of birth</label>
      <input type="date" class="c-dob" value="${esc(c.birth_date ?? "")}">
      <div class="hint">This decides which classes they can join.</div></div>
    <div class="field"><label>Their email</label>
      <input type="email" class="c-email" value="${esc(c.email ?? "")}">
      <div class="hint">Older children only, if they have one.</div></div>
    <div class="field"><label>Their phone</label>
      <input type="tel" class="c-phone" value="${esc(c.phone ?? "")}"></div>
    <div class="field wide"><label>Allergies</label>
      <input type="text" class="c-allergies" value="${esc(c.allergies ?? "")}"
             placeholder="None">
      <div class="hint">Teachers see this on their class list.</div></div>
    <div class="field wide"><label>Anything a teacher should know</label>
      <textarea class="c-medical" rows="2"
        placeholder="Asthma inhaler in her bag, needs a quiet moment if overwhelmed…"
      >${esc(c.medical_notes ?? "")}</textarea></div>
  </div>`;
}

function addChild(el, familyId) {
  const card = $(`.famcard[data-family="${familyId}"]`, el);
  const host = $(".children", card);
  const div = document.createElement("div");
  div.innerHTML = childRow();
  host.appendChild(div.firstElementChild);
  host.lastElementChild.querySelector(".c-first").focus();
}

function addParent(el, familyId) {
  const card = $(`.famcard[data-family="${familyId}"]`, el);
  const host = $(".parents", card);
  const div = document.createElement("div");
  div.innerHTML = parentRow();
  host.appendChild(div.firstElementChild);
  host.lastElementChild.querySelector(".p-first").focus();
}

async function save(el, familyId) {
  const card = $(`.famcard[data-family="${familyId}"]`, el);
  const btn = $("[data-save]", card);
  const state = $(".save-state", card);

  const body = {
    family_id: familyId,
    primary_email: $(".fam-email", card).value.trim(),
    primary_phone: $(".fam-phone", card).value.trim(),
    parents: $$(".parent", card).map((r) => ({
      id: r.dataset.id ?? null,
      first_name: $(".p-first", r).value.trim(),
      last_name: $(".p-last", r).value.trim(),
      email: $(".p-email", r).value.trim(),
      phone: $(".p-phone", r).value.trim(),
    })).filter((p) => p.id || p.first_name),
    children: $$(".child", card).map((r) => ({
      id: r.dataset.id ?? null,
      first_name: $(".c-first", r).value.trim(),
      last_name: $(".c-last", r).value.trim(),
      birth_date: $(".c-dob", r).value,
      email: $(".c-email", r).value.trim(),
      phone: $(".c-phone", r).value.trim(),
      allergies: $(".c-allergies", r).value.trim(),
      medical_notes: $(".c-medical", r).value.trim(),
    })).filter((c) => c.id || c.first_name),
  };

  // A new child with no date of birth cannot be placed in anything, so it is
  // worth stopping for rather than saving and letting them find out in August.
  const undated = body.children.filter((c) => !c.id && !c.birth_date);
  if (undated.length) {
    toastErr(`${undated[0].first_name || "That child"} needs a date of birth — ` +
             "it decides which classes they can join.");
    return;
  }

  btn.disabled = true;
  state.textContent = "Saving…";

  try {
    const res = await api.updateFamilySetup(body);
    if (!res?.ok) throw new Error(res?.error === "not_your_family"
      ? "That is not your family." : "Could not save those changes.");
    toastOk("Saved.");
    data = await api.familySetup();
    draw(el);
  } catch (e) {
    btn.disabled = false;
    state.textContent = "";
    toastErr(e.message);
  }
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}


/**
 * Volunteering, as a family sees it.
 *
 * Read-only. Offers are made during class sign-up and placements are made by an
 * administrator — but until now a family could learn neither from the portal,
 * which is where they actually are. Being told your child is helping in the
 * preschool class on Thursday should not require an email.
 */
function volunteerCard() {
  const kids = (volunteering?.children ?? []).filter(
    (c) => c.offered || (c.assigned_to ?? []).length);

  if (!kids.length) return "";

  return `<div class="card">
    <div class="card-head">
      <h3>Volunteering${volunteering?.semester
        ? ` — ${esc(volunteering.semester.name)}` : ""}</h3>
    </div>
    <p class="muted">Older students can offer to help in the younger children's
      classes. Offers are made when you sign up for classes; where they end up
      is decided by the co-op.</p>

    <div class="people mt">${kids.map((c) => {
      const placed = c.assigned_to ?? [];
      return `<div class="person" style="display:block">
        <div class="person-head"><strong>${esc(c.name)}</strong></div>

        ${placed.length ? `<div class="mt">
          <span class="badge badge-ok">Helping</span>
          ${placed.map((p) => `<div class="mt">
            <strong>${esc(p.class)}</strong>
            <span class="muted">— ${esc(p.period)}</span></div>`).join("")}
        </div>` : `<div class="mt">
          <span class="badge badge-warn">Offered</span>
          <span class="muted">not placed in a class yet</span>
        </div>`}

        ${(c.offered_for ?? []).length ? `<div class="tiny muted mt">
          Offered for: ${c.offered_for.map(esc).join(", ")}</div>` : ""}
        ${c.note ? `<div class="tiny muted mt">Your note: ${esc(c.note)}</div>` : ""}
      </div>`;
    }).join("")}</div>
  </div>`;
}
