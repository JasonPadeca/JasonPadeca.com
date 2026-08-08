// =============================================================================
// Family registration application (§16, §17, §18, §40).
//
// The whole family registers on one screen. Switching between children never
// loses a selection, because nothing is saved until Submit and the selections
// live in one object until then. One submission covers every child.
// =============================================================================

import { familyApi, IS_CONFIGURED } from "../assets/api.js";
import {
  esc, $, render, fmtDate, fmtTimeRange, eligibilityLabel,
  toastErr, toastOk, plural,
} from "../assets/ui.js";

const app = $("#app");

// --- State -------------------------------------------------------------------

let TOKEN = null;
let DATA = null;          // the payload from family-session
let activeChildId = null;
/** { [childId]: { [classId]: "register" | "waitlist" } } */
let picks = {};
/** Second choices: { [childId]: { [periodId]: classId } } */
let seconds = {};
/** Child ids the parent has marked as sitting this semester out. */
let sittingOut = new Set();
/** { [childId]: { wants: bool, note: string, slots: Set("periodId|classId") } } */
let volunteer = {};
let submitting = false;

// =============================================================================
// Boot
// =============================================================================
(async function boot() {
  if (!IS_CONFIGURED) {
    return renderMessage("Not configured yet",
      "This registration site has not been connected to its database. Please contact your co-op administrator.");
  }

  // The token arrives in the fragment because fragments are never sent to the
  // server — not to GitHub Pages, not in any request this page makes (§15).
  TOKEN = location.hash.slice(1).trim();

  if (TOKEN) {
    // Take the secret out of the visible address bar once we have it, so a
    // shared screen or an over-the-shoulder photo does not leak the link.
    //
    // Stashing it in sessionStorage first is what keeps the page survivable:
    // without it, a parent who hits refresh would be sent back to their email
    // to find the link again. sessionStorage is scoped to this tab and this
    // origin, and the browser discards it when the tab closes.
    try { sessionStorage.setItem("coop_token", TOKEN); } catch { /* private mode */ }
    history.replaceState(null, "", location.pathname + location.search);
  } else {
    try { TOKEN = sessionStorage.getItem("coop_token") ?? ""; } catch { TOKEN = ""; }
  }

  if (!TOKEN) {
    return renderMessage("Registration link required",
      "Open the personalised link from your co-op registration email. If you cannot find it, ask your administrator to resend it.");
  }

  await load();
})();

async function load() {
  const res = await familyApi.session(TOKEN);

  if (!res?.ok) {
    const messages = {
      expired: ["This link has expired",
        "Registration for this semester has closed. If you still need to make a change, contact your co-op administrator."],
      revoked: ["This link is no longer active",
        "A newer registration link was sent to your family. Please check your email for the most recent message, or ask your administrator to resend it."],
      invalid: ["This link is not valid",
        "The link may have been copied incompletely. Try clicking the button in your registration email directly, rather than copying and pasting."],
      family_not_found: ["Family not found",
        "We could not find your family's record. Please contact your co-op administrator."],
      semester_not_found: ["Semester not found",
        "This registration link points to a semester that no longer exists. Please contact your co-op administrator."],
    };
    const [title, body] = messages[res?.error] ?? ["Something went wrong",
      "We could not load your registration. Please try again in a moment, or contact your co-op administrator."];
    return renderMessage(title, body);
  }

  DATA = res;
  $("#programName").textContent = DATA.program_name ?? "Co-op Registration";
  $("#semesterName").textContent = DATA.semester.name;
  document.title = `${DATA.semester.name} Registration — ${DATA.program_name ?? "Co-op"}`;

  // Seed the working selections from whatever is already saved, so reopening
  // the link shows the family what they chose last time rather than a blank
  // slate (§41).
  picks = {};
  for (const r of DATA.registrations ?? []) {
    (picks[r.child_id] ??= {})[r.class_id] =
      r.status === "waitlisted" ? "waitlist" : "register";
  }

  sittingOut = new Set(
    (DATA.children ?? []).filter((c) => c.participating === false).map((c) => c.id));

  // Second choices survive in class_preferences even when they were not used,
  // so restore them rather than making the parent re-enter them.
  seconds = {};
  for (const p of DATA.preferences ?? []) {
    if (p.rank === 2) (seconds[p.child_id] ??= {})[p.period_id] = p.class_id;
  }

  volunteer = {};
  for (const c of DATA.children ?? []) {
    const v = c.volunteer ?? {};
    volunteer[c.id] = {
      wants: v.wants === true,
      note: v.note ?? "",
      slots: new Set((v.slots ?? []).map((s) => `${s.period_id}|${s.class_id ?? ""}`)),
    };
  }

  activeChildId = DATA.children[0]?.id ?? null;
  renderChooser();
}

// =============================================================================
// Selection helpers
// =============================================================================

const childPicks = (id) => picks[id] ?? {};

/** The class this child is confirmed into for a period, if any. */
function pickedInPeriod(childId, period) {
  const p = childPicks(childId);
  return period.classes.find((c) => p[c.id] === "register") ?? null;
}

function waitlistedInPeriod(childId, period) {
  const p = childPicks(childId);
  return period.classes.filter((c) => p[c.id] === "waitlist");
}

function isEligible(cls, childId) {
  return (cls.eligibility?.[childId] ?? []).length === 0;
}

function reasonsFor(cls, childId) {
  return cls.eligibility?.[childId] ?? [];
}

/**
 * How many seats a class has left, counting what this family has picked but not
 * yet submitted. Without this, a parent registering three children could put all
 * three into the last remaining seat and only find out on submit.
 */
function seatsLeft(cls, forChildId) {
  if (cls.capacity == null) return Infinity;

  // Seats this family already holds are inside registered_count; add them back
  // so the family is not counted against itself.
  const alreadyMine = (DATA.registrations ?? [])
    .filter((r) => r.class_id === cls.id && r.status === "registered").length;

  // Picks by this family's OTHER children. The child being looked at is
  // excluded on purpose: their own pick must not make the class read as full
  // to them, which would turn the class they just chose into a waitlist box.
  const nowSiblings = Object.entries(picks)
    .filter(([cid, byClass]) => cid !== forChildId && byClass[cls.id] === "register").length;

  return cls.capacity - cls.registered_count + alreadyMine - nowSiblings;
}

function choose(childId, period, cls, intent) {
  const p = (picks[childId] ??= {});
  if (intent === "register") {
    // One confirmed class per period: clear any other confirmed pick here, but
    // leave waitlist entries alone — they are interest, not a seat (§51 Q3).
    for (const c of period.classes) if (p[c.id] === "register") delete p[c.id];
    p[cls.id] = "register";
  } else if (intent === "waitlist") {
    p[cls.id] = "waitlist";
  } else {
    delete p[cls.id];
  }
  renderChooser();
}

function totalPicked() {
  return Object.values(picks).reduce((n, byClass) => n + Object.keys(byClass).length, 0);
}

// =============================================================================
// Views
// =============================================================================

function renderMessage(title, body, icon = "") {
  render(app, `<div class="centered">
    ${icon ? `<div class="big">${icon}</div>` : ""}
    <h1>${esc(title)}</h1>
    <p class="muted mt">${esc(body)}</p>
  </div>`);
}

function renderChooser() {
  const open = DATA.semester.is_open;
  const editable = open && DATA.allow_edits !== false;

  if (!DATA.children.length) {
    return renderMessage("No children on file",
      "Your family record does not list any active children yet. Please contact your co-op administrator.");
  }

  const child = DATA.children.find((c) => c.id === activeChildId) ?? DATA.children[0];
  activeChildId = child.id;

  render(app, `
    <div class="wrap page">
      <div class="page-head">
        <div>
          <h1>${esc(DATA.family.display_name)}</h1>
          <div class="sub">${esc(DATA.semester.name)} Registration${
            DATA.semester.class_start_date
              ? ` · classes begin ${esc(fmtDate(DATA.semester.class_start_date))}` : ""}</div>
        </div>
      </div>

      ${!open ? `<div class="note note-warn">
        <strong>Registration is closed.</strong> You can review what your family
        is signed up for, but changes now need to go through your co-op administrator.
      </div>` : ""}

      ${open && !editable ? `<div class="note">
        Your registration has been submitted. Contact your administrator if you need to change it.
      </div>` : ""}

      ${open && DATA.semester.registration_close_at ? `<div class="note">
        Registration closes <strong>${esc(fmtDate(DATA.semester.registration_close_at))}</strong>.
      </div>` : ""}

      <div class="reg-layout">
        <div>
          ${renderChildTabs()}
          ${renderParticipation(child, editable)}
          <div id="periods">${renderPeriods(child, editable)}</div>
          ${renderVolunteer(child, editable)}
        </div>
        <div class="reg-summary">
          ${renderSummary(editable)}
        </div>
      </div>
    </div>`);

  wireChooser(editable);
}

function renderChildTabs() {
  if (DATA.children.length === 1) return "";
  return `<div class="childtabs" role="tablist" aria-label="Children">
    ${DATA.children.map((c) => {
      const out = sittingOut.has(c.id);
      const n = Object.keys(childPicks(c.id)).length;
      return `<button class="childtab ${out ? "is-out" : ""}" role="tab"
                data-child="${esc(c.id)}" aria-selected="${c.id === activeChildId}">
        ${esc(c.first_name)}${!out && n ? `<span class="dot" title="${n} selected"></span>` : ""}
        <span class="age">${out
          ? "Sitting out"
          : (c.age != null ? `Age ${c.age}` : "Age unknown")}</span>
      </button>`;
    }).join("")}
  </div>`;
}

/**
 * The per-child "is this one taking classes?" question.
 *
 * A radio pair rather than a checkbox, because the two states are a genuine
 * either/or the parent should answer deliberately — and because "not
 * participating" needs to read as a real choice, not as something forgotten.
 */
function renderParticipation(child, editable) {
  const out = sittingOut.has(child.id);
  return `<fieldset class="participation ${out ? "is-out" : ""}">
    <legend class="lbl">Is ${esc(child.first_name)} taking classes this semester?</legend>
    <div class="participation-choices">
      <label class="pill">
        <input type="radio" name="participating" value="yes"
               ${out ? "" : "checked"} ${editable ? "" : "disabled"}>
        <span>Yes, registering for classes</span>
      </label>
      <label class="pill">
        <input type="radio" name="participating" value="no"
               ${out ? "checked" : ""} ${editable ? "" : "disabled"}>
        <span>Not participating this semester</span>
      </label>
    </div>
    ${out ? `<p class="tiny muted mt">
      ${esc(child.first_name)} will be skipped this semester. Anything previously
      chosen for ${esc(child.first_name)} will be released when you submit.
      You can change this at any time before registration closes.
    </p>` : ""}
  </fieldset>`;
}

function renderPeriods(child, editable) {
  // A child sitting out has no schedule to build, so the class lists are
  // replaced rather than merely disabled — there is nothing to read there.
  if (sittingOut.has(child.id)) {
    return `<div class="empty">
      <h3>${esc(child.first_name)} is sitting this semester out</h3>
      <p>Switch the choice above back to “Yes” to pick classes for
         ${esc(child.first_name)}.</p>
      ${DATA.children.length > 1
        ? `<p class="tiny faint mt">Your other children are unaffected — carry on with them above.</p>`
        : ""}
    </div>`;
  }

  if (!DATA.periods.length) {
    return `<div class="empty"><h3>No classes yet</h3>
      <p>This semester's schedule has not been published.</p></div>`;
  }

  return DATA.periods.map((period) => {
    const chosen = pickedInPeriod(child.id, period);
    const waits = waitlistedInPeriod(child.id, period);

    const options = period.classes.map((cls) => renderOption(cls, child, period, editable)).join("");

    // A fieldset, so the class options in a period are announced as one group.
    // The radios inside share a name, which is what gives arrow-key navigation
    // between them for free.
    return `<section class="period-block">
      <fieldset>
        <legend>
          <h3>
            ${esc(period.display_name)}
            <span class="period-time small faint">${esc(fmtTimeRange(period.start_time, period.end_time))}</span>
            ${chosen
              ? `<span class="badge badge-accent">${esc(chosen.name)}</span>`
              : `<span class="badge">Nothing chosen</span>`}
            ${waits.length ? `<span class="badge badge-warn">${plural(waits.length, "waitlist")}</span>` : ""}
          </h3>
        </legend>
        ${options || `<div class="empty small">No classes in this period.</div>`}
        ${renderSecondChoice(child, period, chosen, editable)}
        ${chosen && editable ? `<div class="clear">
          <button type="button" class="btn btn-sm btn-ghost" data-clear="${esc(period.id)}">
            Clear ${esc(child.first_name)}'s ${esc(period.display_name)} choice
          </button></div>` : ""}
      </fieldset>
    </section>`;
  }).join("");
}

/**
 * The optional fallback for a period.
 *
 * A <select> rather than a second list of cards: it is one line instead of
 * eight, and only appears once a first choice exists, so the common case —
 * a parent who just wants one class — never sees it at all.
 *
 * Only classes the child is actually eligible for are offered. A fallback that
 * cannot be taken is worse than none, because the parent believes they are
 * covered.
 */
function renderSecondChoice(child, period, chosen, editable) {
  if (!chosen) return "";

  const candidates = period.classes.filter((c) =>
    c.id !== chosen.id && isEligible(c, child.id));
  if (!candidates.length) return "";

  const current = seconds[child.id]?.[period.id] ?? "";

  return `<div class="second">
    <label for="sec_${esc(period.id)}">
      If ${esc(chosen.name)} fills up, try instead <span class="faint">(optional)</span>
    </label>
    <select id="sec_${esc(period.id)}" data-second="${esc(period.id)}" ${editable ? "" : "disabled"}>
      <option value="">No second choice — ${esc(child.first_name)} will go without this period</option>
      ${candidates.map((c) => `<option value="${esc(c.id)}"${c.id === current ? " selected" : ""}>
        ${esc(c.name)}${c.is_full ? " (also full)" : ""}</option>`).join("")}
    </select>
  </div>`;
}

function renderOption(cls, child, period, editable) {
  const reasons = reasonsFor(cls, child.id);
  const eligible = reasons.length === 0;

  // §17: hidden or shown-disabled is an administrator setting.
  if (!eligible && DATA.show_ineligible === false) return "";

  const state = childPicks(child.id)[cls.id];
  const left = seatsLeft(cls, child.id);
  const full = left <= 0;
  const checked = state === "register" || state === "waitlist";

  const classes = ["opt"];
  if (!eligible) classes.push("inelig");
  else if (full) classes.push("full");

  const meta = [
    eligibilityLabel(cls),
    cls.teacher_name,
    cls.capacity == null
      ? null
      : full
        ? (cls.waitlisted_count
            ? `Full · ${plural(cls.waitlisted_count, "person", "people")} waiting`
            : "Full")
        : `${plural(left, "seat")} left`,
  ].filter(Boolean).join(" · ");

  const intent = full ? "waitlist" : "register";
  const disabled = !eligible || !editable;

  // Two genuinely different questions, so two different controls:
  //
  //   "Which class this period?"  — one answer, so a radio, and every radio in
  //     the period shares a name. That is what makes arrow keys walk the list
  //     and lets a screen reader say "3 of 8".
  //   "Join the waitlist for this full class?" — an independent yes/no that
  //     does not consume the period, so a checkbox (§51 Q3).
  const type = full ? "checkbox" : "radio";
  const name = full
    ? `wl_${esc(child.id)}_${esc(cls.id)}`
    : `reg_${esc(child.id)}_${esc(period.id)}`;

  return `<label class="${classes.join(" ")}">
    <input type="${type}" name="${name}"
           data-class="${esc(cls.id)}" data-period="${esc(period.id)}"
           data-intent="${intent}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}>
    <div class="body">
      <span class="mark" aria-hidden="true"></span>
      <span class="info">
        <span class="name">${esc(cls.name)}</span>
        ${meta ? `<span class="meta">${esc(meta)}</span>` : ""}
        ${cls.description ? `<span class="meta">${esc(cls.description)}</span>` : ""}
        ${!eligible ? `<span class="why">${esc(reasons.join(" · "))} — not eligible for ${esc(child.first_name)}</span>` : ""}
        ${eligible && full && state !== "waitlist"
          ? `<span class="why">This class is full. Ticking this joins the waitlist.</span>` : ""}
        ${state === "waitlist" ? `<span class="why">On the waitlist for this class.</span>` : ""}
      </span>
    </div>
  </label>`;
}

/**
 * "Would this child like to help?"
 *
 * Collapsed to a single question until the answer is yes, so a family who is
 * not volunteering sees one extra line and nothing more. The detail — which
 * period, which classes — only appears once it is relevant.
 *
 * This records willingness. It assigns nobody to anything; an administrator
 * still does the actual asking.
 */
function renderVolunteer(child, editable) {
  if (sittingOut.has(child.id)) return "";

  const v = volunteer[child.id] ?? { wants: false, note: "", slots: new Set() };

  return `<fieldset class="volunteer ${v.wants ? "is-on" : ""}">
    <legend class="lbl">Would ${esc(child.first_name)} like to volunteer this semester?</legend>
    <div class="participation-choices">
      <label class="pill">
        <input type="radio" name="volunteer" value="no"
               ${v.wants ? "" : "checked"} ${editable ? "" : "disabled"}>
        <span>Not this time</span>
      </label>
      <label class="pill">
        <input type="radio" name="volunteer" value="yes"
               ${v.wants ? "checked" : ""} ${editable ? "" : "disabled"}>
        <span>Yes, ${esc(child.first_name)} would like to help</span>
      </label>
    </div>

    ${v.wants ? `<div class="volunteer-detail">
      <p class="tiny muted">Tick a period to offer any class in it, or pick out
        particular classes. Anything you leave blank just means “no preference”.</p>

      ${DATA.periods.map((p) => {
        const anyKey = `${p.id}|`;
        const wholePeriod = v.slots.has(anyKey);
        return `<div class="vol-period">
          <label class="check">
            <input type="checkbox" data-vol-period="${esc(p.id)}"
                   ${wholePeriod ? "checked" : ""} ${editable ? "" : "disabled"}>
            <strong>${esc(p.display_name)}</strong>
            <span class="faint tiny">${esc(fmtTimeRange(p.start_time, p.end_time))}</span>
          </label>
          <div class="vol-classes">
            ${p.classes.map((c) => {
              const key = `${p.id}|${c.id}`;
              return `<label class="chip">
                <input type="checkbox" data-vol-class="${esc(c.id)}" data-vol-in="${esc(p.id)}"
                       ${v.slots.has(key) ? "checked" : ""}
                       ${editable && !wholePeriod ? "" : "disabled"}>
                <span>${esc(c.name)}</span>
              </label>`;
            }).join("") || `<span class="tiny faint">No classes in this period yet.</span>`}
          </div>
        </div>`;
      }).join("")}

      <div class="field mt">
        <label for="volnote">Anything we should know? <span class="faint">(optional)</span></label>
        <input type="text" id="volnote" maxlength="500" value="${esc(v.note ?? "")}"
               placeholder="Good with younger children, can only do mornings…"
               ${editable ? "" : "disabled"}>
      </div>
    </div>` : ""}
  </fieldset>`;
}

function renderSummary(editable) {
  const rows = DATA.children.map((child) => {
    if (sittingOut.has(child.id)) {
      return `<div class="sum-child">
        <div class="who">${esc(child.first_name)}</div>
        <div class="sum-row none"><span class="c">Not participating this semester</span></div>
      </div>`;
    }
    const lines = DATA.periods.map((period) => {
      const chosen = pickedInPeriod(child.id, period);
      const waits = waitlistedInPeriod(child.id, period);
      if (!chosen && !waits.length) {
        return `<div class="sum-row none"><span class="p">${period.period_number}</span>
          <span class="c">—</span></div>`;
      }
      const second = seconds[child.id]?.[period.id];
      const secondName = second
        ? period.classes.find((c) => c.id === second)?.name : null;
      return `<div class="sum-row"><span class="p">${period.period_number}</span>
        <span class="c">${chosen ? esc(chosen.name) : `<span class="faint">—</span>`}
        ${chosen && secondName ? `<div class="alt">then ${esc(secondName)}</div>` : ""}
        ${waits.map((w) => `<div class="wl">Waitlist: ${esc(w.name)}</div>`).join("")}
        </span></div>`;
    }).join("");

    return `<div class="sum-child">
      <div class="who">${esc(child.first_name)}</div>${lines}</div>`;
  }).join("");

  const missing = countMissing();

  return `<div class="card">
    <div class="card-head"><h3>Your Schedule</h3></div>
    ${rows}
    ${missing ? `<div class="note note-warn mt tiny">
      ${missing === 1 ? "One child has" : `${missing} children have`} an empty period.
      That is fine if it is what you want.
    </div>` : ""}
    ${editable ? `<button class="btn btn-primary btn-block mt" id="review"
      ${canSubmit() ? "" : "disabled"}>Review &amp; Submit</button>` : ""}
  </div>`;
}

/**
 * A submission is worth making once the parent has said something — either
 * picked a class, or declared somebody out. A family where everyone is sitting
 * out has nothing selected and must still be able to submit, which is why this
 * is not simply "has selections".
 */
function canSubmit() {
  return totalPicked() > 0 || sittingOut.size > 0;
}

function countMissing() {
  return DATA.children.filter((child) =>
    !sittingOut.has(child.id) &&
    DATA.periods.some((p) => p.classes.length && !pickedInPeriod(child.id, p))
  ).length;
}

function wireChooser(editable) {
  app.querySelectorAll(".childtab").forEach((tab) =>
    tab.addEventListener("click", () => {
      activeChildId = tab.dataset.child;
      renderChooser();
    }));

  if (!editable) return;

  app.querySelectorAll('.participation input[name="participating"]').forEach((input) =>
    input.addEventListener("change", () => {
      if (input.value === "no") {
        sittingOut.add(activeChildId);
        // Drop their selections now rather than at submit, so the summary and
        // the confirmation both tell the truth about what is being sent.
        delete picks[activeChildId];
      } else {
        sittingOut.delete(activeChildId);
      }
      renderChooser();
    }));

  app.querySelectorAll("#periods input").forEach((input) =>
    input.addEventListener("change", () => {
      const period = DATA.periods.find((p) => p.id === input.dataset.period);
      const cls = period.classes.find((c) => c.id === input.dataset.class);
      const child = DATA.children.find((c) => c.id === activeChildId);

      // A checkbox reports its own new state; a radio is always "now chosen",
      // and clearing a period is what the Clear button is for.
      const intent = input.type === "checkbox"
        ? (input.checked ? "waitlist" : null)
        : input.dataset.intent;

      choose(child.id, period, cls, intent);
    }));

  app.querySelectorAll("[data-second]").forEach((sel) =>
    sel.addEventListener("change", () => {
      const byPeriod = (seconds[activeChildId] ??= {});
      if (sel.value) byPeriod[sel.dataset.second] = sel.value;
      else delete byPeriod[sel.dataset.second];
      renderChooser();
    }));

  // --- volunteering ---
  const vol = () => (volunteer[activeChildId] ??= { wants: false, note: "", slots: new Set() });

  app.querySelectorAll('.volunteer input[name="volunteer"]').forEach((input) =>
    input.addEventListener("change", () => {
      const v = vol();
      v.wants = input.value === "yes";
      if (!v.wants) v.slots.clear();
      renderChooser();
    }));

  app.querySelectorAll("[data-vol-period]").forEach((box) =>
    box.addEventListener("change", () => {
      const v = vol();
      const pid = box.dataset.volPeriod;
      const period = DATA.periods.find((p) => p.id === pid);
      if (box.checked) {
        // Offering the whole period supersedes any individual classes in it.
        for (const c of period.classes) v.slots.delete(`${pid}|${c.id}`);
        v.slots.add(`${pid}|`);
      } else {
        v.slots.delete(`${pid}|`);
      }
      renderChooser();
    }));

  app.querySelectorAll("[data-vol-class]").forEach((box) =>
    box.addEventListener("change", () => {
      const v = vol();
      const key = `${box.dataset.volIn}|${box.dataset.volClass}`;
      if (box.checked) v.slots.add(key); else v.slots.delete(key);
    }));

  $("#volnote")?.addEventListener("input", (e) => { vol().note = e.target.value; });

  app.querySelectorAll("[data-clear]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const period = DATA.periods.find((p) => p.id === btn.dataset.clear);
      const p = picks[activeChildId] ?? {};
      for (const c of period.classes) if (p[c.id] === "register") delete p[c.id];
      renderChooser();
    }));

  $("#review")?.addEventListener("click", renderReview);
}

// =============================================================================
// Review and submit (§18)
// =============================================================================

function renderReview() {
  const blocks = DATA.children.map((child) => {
    if (sittingOut.has(child.id)) {
      return `<div class="review-child">
        <div class="who">${esc(child.first_name)} ${esc(child.last_name ?? "")}</div>
        <div class="review-row faint"><span>Not participating this semester</span></div>
      </div>`;
    }
    const lines = DATA.periods.map((period) => {
      const chosen = pickedInPeriod(child.id, period);
      const waits = waitlistedInPeriod(child.id, period);
      const second = seconds[child.id]?.[period.id];
      const secondName = second
        ? period.classes.find((c) => c.id === second)?.name : null;
      const bits = [];
      if (chosen) bits.push(`<div class="review-row">
        <strong>${esc(period.display_name)}</strong><span>${esc(chosen.name)}
        ${secondName
          ? `<div class="tiny muted">If it fills up: ${esc(secondName)}</div>`
          : ""}</span></div>`);
      for (const w of waits) bits.push(`<div class="review-row">
        <strong>${esc(period.display_name)}</strong>
        <span>${esc(w.name)} <span class="badge badge-warn">Waitlist</span></span></div>`);
      if (!bits.length) bits.push(`<div class="review-row faint">
        <strong>${esc(period.display_name)}</strong><span>No class</span></div>`);
      return bits.join("");
    }).join("");
    return `<div class="review-child"><div class="who">${esc(child.first_name)} ${esc(child.last_name ?? "")}</div>${lines}</div>`;
  }).join("");

  render(app, `<div class="wrap-narrow page">
    <div class="page-head"><div>
      <h1>Review ${esc(DATA.semester.name)} Registration</h1>
      <div class="sub">${esc(DATA.family.display_name)}</div>
    </div></div>
    <div class="card">${blocks}</div>
    <div class="btn-row mt2">
      <button class="btn" id="back">Back</button>
      <button class="btn btn-primary" id="confirm">Confirm Registration</button>
    </div>
    <p class="tiny faint mt">A confirmation email will be sent to
      ${esc(DATA.family.primary_email ?? "your family")}.</p>
  </div>`);

  $("#back").addEventListener("click", renderChooser);
  $("#confirm").addEventListener("click", submit);
  window.scrollTo(0, 0);
}

async function submit(e) {
  if (submitting) return;
  submitting = true;

  const btn = e.currentTarget;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Saving…`;

  const selections = [];
  for (const [childId, byClass] of Object.entries(picks)) {
    if (sittingOut.has(childId)) continue;
    for (const [classId, intent] of Object.entries(byClass)) {
      selections.push({ child_id: childId, class_id: classId, intent, rank: 1 });
    }
  }

  // Second choices ride along as rank 2; the backend only reaches for them if
  // the rank 1 class in that period turns out to be full.
  for (const [childId, byPeriod] of Object.entries(seconds)) {
    if (sittingOut.has(childId)) continue;
    for (const [periodId, classId] of Object.entries(byPeriod)) {
      const period = DATA.periods.find((p) => p.id === periodId);
      // Meaningless without a first choice in the same period.
      if (!period || !pickedInPeriod(childId, period)) continue;
      selections.push({ child_id: childId, class_id: classId, intent: "register", rank: 2 });
    }
  }

  const volunteerPayload = {};
  for (const [childId, v] of Object.entries(volunteer)) {
    if (sittingOut.has(childId)) continue;
    volunteerPayload[childId] = {
      wants: v.wants,
      note: v.note || null,
      slots: v.wants
        ? [...v.slots].map((k) => {
            const [period_id, class_id] = k.split("|");
            return { period_id, class_id: class_id || null };
          })
        : [],
    };
  }

  const res = await familyApi.submit(TOKEN, selections, [...sittingOut], volunteerPayload);
  submitting = false;

  if (!res?.ok) {
    btn.disabled = false;
    btn.textContent = "Confirm Registration";
    if (res?.error === "registration_closed") {
      return renderMessage("Registration has closed",
        res.message ?? "The registration deadline passed while you were choosing. Please contact your co-op administrator.");
    }
    return toastErr(res?.message ?? "We could not save your registration. Please try again.");
  }

  renderConfirmation(res);
}

// =============================================================================
// Confirmation (§18)
// =============================================================================

function renderConfirmation(res) {
  // The results array is authoritative about what actually happened, which is
  // not always what was asked for — a class can fill up mid-submission.
  const byKey = new Map(res.results.map((r) => [`${r.child_id}|${r.class_id}`, r]));
  const classById = new Map();
  const periodOf = new Map();
  for (const p of DATA.periods) {
    for (const c of p.classes) { classById.set(c.id, c); periodOf.set(c.id, p); }
  }

  // A first choice that filled up is only a problem if nothing else caught it.
  // Where the second choice worked, the parent needs to know what happened, not
  // to be told something went wrong.
  const covered = new Set(
    res.results
      .filter((r) => r.outcome === "registered")
      .map((r) => `${r.child_id}|${periodOf.get(r.class_id)?.id ?? ""}`));

  const problems = res.results.filter((r) =>
    (r.outcome === "full" || r.outcome === "rejected" || r.outcome === "ineligible") &&
    !covered.has(`${r.child_id}|${periodOf.get(r.class_id)?.id ?? ""}`));

  const blocks = DATA.children.map((child) => {
    if (sittingOut.has(child.id)) {
      return `<div class="review-child">
        <div class="who">${esc(child.first_name)} ${esc(child.last_name ?? "")}</div>
        <div class="review-row faint"><span>Not participating this semester</span></div>
      </div>`;
    }
    const got = res.results
      .filter((r) => r.child_id === child.id &&
                     (r.outcome === "registered" || r.outcome === "waitlisted"))
      // By period, and within a period the confirmed seat before any waitlist
      // entry — the class they actually have is the answer they came for.
      .sort((a, b) =>
        ((periodOf.get(a.class_id)?.period_number ?? 0) -
         (periodOf.get(b.class_id)?.period_number ?? 0)) ||
        ((a.outcome === "waitlisted" ? 1 : 0) - (b.outcome === "waitlisted" ? 1 : 0)));

    const lines = got.length
      ? got.map((r) => `<div class="review-row">
          <strong>${esc(periodOf.get(r.class_id)?.display_name ?? "")}</strong>
          <span>${esc(classById.get(r.class_id)?.name ?? "")}
          ${r.outcome === "waitlisted"
            ? `<span class="badge badge-warn">Waitlist${r.waitlist_position ? ` #${r.waitlist_position}` : ""}</span>`
            : ""}
          ${r.used_second_choice
            ? `<span class="badge badge-accent">Second choice</span>
               <div class="tiny muted">Your first choice filled up.</div>`
            : ""}</span></div>`).join("")
      : `<div class="review-row faint"><span>No classes</span></div>`;

    return `<div class="review-child"><div class="who">${esc(child.first_name)} ${esc(child.last_name ?? "")}</div>${lines}</div>`;
  }).join("");

  render(app, `<div class="wrap-narrow page">
    <div class="page-head"><div>
      <h1>Registration Confirmed</h1>
      <div class="sub">${esc(DATA.family.display_name)} · ${esc(DATA.semester.name)}</div>
    </div></div>

    ${problems.length ? `<div class="note note-warn">
      <strong>Some choices could not be saved:</strong>
      <ul>${problems.map((p) => `<li>${esc(nameFor(p, classById))}: ${esc(p.detail ?? p.outcome)}</li>`).join("")}</ul>
      You can go back and pick something else, or contact your administrator.
    </div>` : ""}

    ${res.emailed === false ? `<div class="note">
      We saved your registration, but the confirmation email could not be sent.
      Your registration is safe — your administrator has been notified.
    </div>` : `<div class="note note-ok">
      A confirmation email is on its way to ${esc(DATA.family.primary_email ?? "your family")}.
    </div>`}

    <div class="card">${blocks}</div>

    ${DATA.semester.is_open && DATA.allow_edits !== false ? `
      <div class="btn-row mt2">
        <button class="btn" id="again">Make Another Change</button>
      </div>
      <p class="tiny faint mt">You can come back to your registration link any time
        before registration closes.</p>` : ""}
  </div>`);

  $("#again")?.addEventListener("click", async () => {
    await load();     // re-read from the server; the world may have moved on
    window.scrollTo(0, 0);
  });

  toastOk("Registration saved.");
  window.scrollTo(0, 0);
}

function nameFor(result, classById) {
  const child = DATA.children.find((c) => c.id === result.child_id);
  const cls = classById.get(result.class_id);
  return `${child?.first_name ?? "Child"} — ${cls?.name ?? "class"}`;
}
