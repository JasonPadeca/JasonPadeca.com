// =============================================================================
// Small DOM and formatting helpers shared by the admin and family apps.
//
// No framework. The app is a few thousand lines and one maintainer; a build step
// would cost more than it saves here.
// =============================================================================

/**
 * Escape text for interpolation into an HTML template literal.
 *
 * Everything user-entered — child names, family names, teacher names, notes —
 * goes through this. It is the only thing standing between an admin typing an
 * angle bracket and a broken page, so use it every time, including on values
 * you are fairly sure are safe.
 */
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Replace an element's contents with trusted HTML and return it. */
export function render(el, html) {
  const node = typeof el === "string" ? $(el) : el;
  if (node) node.innerHTML = html;
  return node;
}

/** Delegated event binding, so re-rendered content keeps working. */
export function on(root, event, selector, handler) {
  (typeof root === "string" ? $(root) : root)
    .addEventListener(event, (e) => {
      const target = e.target.closest(selector);
      if (target && root.contains?.(target) !== false) handler(e, target);
    });
}

// --- Formatting --------------------------------------------------------------

export function fmtDate(d) {
  if (!d) return "";
  // Date-only values are parsed as UTC by Date, which shows the previous day in
  // any western timezone. Splitting the parts avoids that entirely.
  const [y, m, day] = String(d).slice(0, 10).split("-").map(Number);
  if (!y) return "";
  return new Date(y, m - 1, day).toLocaleDateString("en-US",
    { month: "long", day: "numeric", year: "numeric" });
}

export function fmtDateShort(d) {
  if (!d) return "";
  const [y, m, day] = String(d).slice(0, 10).split("-").map(Number);
  if (!y) return "";
  return new Date(y, m - 1, day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function fmtDateTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString("en-US",
    { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export function fmtTime(t) {
  if (!t) return "";
  const [h, m] = String(t).split(":").map(Number);
  const ampm = h >= 12 ? "pm" : "am";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")}${ampm}`;
}

export function fmtTimeRange(a, b) {
  if (!a && !b) return "";
  return b ? `${fmtTime(a)}–${fmtTime(b)}` : fmtTime(a);
}

export function relTime(ts) {
  if (!ts) return "never";
  const secs = (Date.now() - new Date(ts).getTime()) / 1000;
  if (secs < 90) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 36) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : (many ?? one + "s")}`;
}

/** "Ages 11–14", "Ages 11 and up", "Girls · Ages 12–17", or "" */
export function eligibilityLabel(c) {
  const bits = [];
  if (c.sex_requirement === "female") bits.push("Girls");
  if (c.sex_requirement === "male") bits.push("Boys");
  if (c.age_min != null && c.age_max != null) bits.push(`Ages ${c.age_min}–${c.age_max}`);
  else if (c.age_min != null) bits.push(`Ages ${c.age_min} and up`);
  else if (c.age_max != null) bits.push(`Ages ${c.age_max} and under`);
  return bits.join(" · ");
}

// --- Toasts ------------------------------------------------------------------

function toastHost() {
  let host = $("#toasts");
  if (!host) {
    host = document.createElement("div");
    host.id = "toasts";
    document.body.appendChild(host);
  }
  return host;
}

export function toast(message, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.setAttribute("role", kind === "err" ? "alert" : "status");
  el.textContent = message;
  toastHost().appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .3s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 300);
  }, kind === "err" ? 7000 : 3800);
}

export const toastOk  = (m) => toast(m, "ok");
export const toastErr = (m) => toast(m, "err");

// --- Dialogs -----------------------------------------------------------------

/**
 * Wire a dialog's buttons and settle a promise exactly once.
 *
 * Deliberately does NOT rely on the `close` event. `<form method="dialog">`
 * closes the dialog and sets returnValue, but some engines do not then fire
 * `close`, and a caller awaiting that event waits forever — a dialog that
 * dismisses itself while the operation behind it never runs. Driving the
 * buttons directly is the same UX with none of that exposure.
 *
 * `onSettle(value)` maps the pressed button to the resolved value; Escape and
 * any stray close resolve as a dismissal.
 */
function wireDialog(dlg, resolve, onSettle) {
  let settled = false;
  const finish = (value) => {
    // undefined means the handler rejected the input — stay open.
    if (settled || value === undefined) return;
    settled = true;
    try { dlg.close(); } catch { /* already closed */ }
    dlg.remove();
    resolve(value);
  };

  dlg.querySelectorAll("button[data-choice]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      finish(onSettle(btn.dataset.choice, dlg));
    }));

  // Escape, and any close we did not initiate, count as walking away.
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(null); });
  dlg.addEventListener("close", () => finish(null));

  document.body.appendChild(dlg);
  dlg.showModal();
}

/**
 * Show a modal and resolve with the value of whichever button was pressed
 * (null if dismissed). `buttons` is [{ value, label, class }].
 */
export function modal({ title, body, buttons = [{ value: null, label: "Close" }] }) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.innerHTML = `
      <div class="dialog-head"><h3>${esc(title)}</h3></div>
      <div class="dialog-body">${body}</div>
      <div class="dialog-foot">
        ${buttons.map((b, i) =>
          `<button type="button" class="btn ${b.class ?? ""}" data-choice="${i}">${esc(b.label)}</button>`
        ).join("")}
      </div>`;

    wireDialog(dlg, resolve, (i) => buttons[Number(i)]?.value ?? null);

    // Focus the affirmative action rather than whatever the browser picks.
    dlg.querySelector(".btn-primary, .btn-danger, .btn")?.focus();
  });
}

export function confirmDialog(title, message, confirmLabel = "Confirm", danger = false) {
  return modal({
    title,
    body: `<p>${esc(message)}</p>`,
    buttons: [
      { value: false, label: "Cancel" },
      { value: true, label: confirmLabel, class: danger ? "btn-danger" : "btn-primary" },
    ],
  });
}

/**
 * Prompt built from a field list; resolves to an object of values, or null.
 * fields: [{ name, label, type, value, options, required, hint, min, max, step }]
 */
export function formDialog({ title, fields, submitLabel = "Save" }) {
  const html = fields.map((f) => {
    const id = `f_${f.name}`;
    const req = f.required ? " required" : "";
    let input;
    if (f.type === "select") {
      input = `<select id="${id}" name="${esc(f.name)}"${req}>${
        f.options.map((o) =>
          `<option value="${esc(o.value)}"${String(o.value) === String(f.value ?? "") ? " selected" : ""}>${esc(o.label)}</option>`
        ).join("")}</select>`;
    } else if (f.type === "textarea") {
      input = `<textarea id="${id}" name="${esc(f.name)}"${req}>${esc(f.value ?? "")}</textarea>`;
    } else if (f.type === "checkbox") {
      input = `<label class="check"><input type="checkbox" id="${id}" name="${esc(f.name)}"${f.value ? " checked" : ""}> ${esc(f.checkLabel ?? "")}</label>`;
    } else {
      const attrs = ["min", "max", "step", "placeholder"]
        .filter((a) => f[a] != null).map((a) => `${a}="${esc(f[a])}"`).join(" ");
      input = `<input type="${f.type ?? "text"}" id="${id}" name="${esc(f.name)}" value="${esc(f.value ?? "")}"${req} ${attrs}>`;
    }
    return `<div class="field">
      ${f.type === "checkbox" ? "" : `<label for="${id}">${esc(f.label)}${f.required ? " *" : ""}</label>`}
      ${input}
      ${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ""}
    </div>`;
  }).join("");

  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    // A real <form> so Enter submits and required fields are validated by the
    // browser, but submission is intercepted rather than left to method="dialog".
    dlg.innerHTML = `
      <form novalidate>
        <div class="dialog-head"><h3>${esc(title)}</h3></div>
        <div class="dialog-body">${html}</div>
        <div class="dialog-foot">
          <button type="button" class="btn" data-choice="cancel">Cancel</button>
          <button type="submit" class="btn btn-primary" data-choice="ok">${esc(submitLabel)}</button>
        </div>
      </form>`;

    const collect = () => {
      const out = {};
      for (const f of fields) {
        const el = dlg.querySelector(`[name="${CSS.escape(f.name)}"]`);
        if (!el) continue;
        if (f.type === "checkbox") out[f.name] = el.checked;
        else if (f.type === "number") out[f.name] = el.value === "" ? null : Number(el.value);
        else out[f.name] = el.value.trim() === "" ? null : el.value.trim();
      }
      return out;
    };

    // Required fields are checked here, because novalidate turned off the
    // browser's own pass. Returning undefined tells wireDialog to stay open.
    const validate = () => {
      for (const f of fields) {
        if (!f.required) continue;
        const el = dlg.querySelector(`[name="${CSS.escape(f.name)}"]`);
        if (el && !el.value.trim()) {
          el.focus();
          el.style.borderColor = "var(--danger)";
          toastErr(`${f.label} is required.`);
          return false;
        }
      }
      return true;
    };

    wireDialog(dlg, resolve,
      (choice) => (choice === "ok" ? (validate() ? collect() : undefined) : null));

    dlg.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      dlg.querySelector('[data-choice="ok"]').click();
    });

    dlg.querySelector("input, select, textarea")?.focus();
  });
}

// --- Misc --------------------------------------------------------------------

export function loading(el, label = "Loading…") {
  render(el, `<div class="loading"><span class="spinner"></span> ${esc(label)}</div>`);
}

/** Trigger a client-side CSV download (§33). */
export function downloadCSV(filename, rows) {
  const cell = (v) => {
    const s = v == null ? "" : String(v);
    // Leading =, +, -, @ are formula triggers in Excel and Sheets. A child
    // named "-Anne" should not become a spreadsheet expression.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const csv = rows.map((r) => r.map(cell).join(",")).join("\r\n");
  // The BOM makes Excel open UTF-8 correctly instead of mangling accents.
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Debounce, for search boxes. */
export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
