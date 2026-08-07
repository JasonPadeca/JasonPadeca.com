// =============================================================================
// Program roster (§9) — who is currently in this homeschool program.
//
// Families, parents, and children are permanent records. Nothing here deletes
// anything; the strongest action is Archive, which hides a record from normal
// screens while leaving every historical registration intact (§2.3, §6).
// =============================================================================

import { api } from "../../assets/api.js";
import {
  esc, $, render, fmtDate, toastOk, toastErr, plural, debounce,
  formDialog, confirmDialog,
} from "../../assets/ui.js";
import { refresh, go } from "../app.js";

// -----------------------------------------------------------------------------
// List
// -----------------------------------------------------------------------------
export async function list(app) {
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const showArchived = params.get("archived") === "1";

  const families = await api.families({ includeArchived: showArchived });
  const visible = showArchived ? families.filter((f) => f.archived_at) : families;

  const activeChildren = visible.reduce((n, f) =>
    n + (f.children ?? []).filter((c) => c.active && !c.archived_at).length, 0);

  render(app, `<div class="wrap page">
    <div class="page-head">
      <div>
        <h1>${showArchived ? "Archived Families" : "Families"}</h1>
        <div class="sub">${plural(visible.length, showArchived ? "archived family" : "active family",
                                  showArchived ? "archived families" : "active families")}
          · ${plural(activeChildren, "child", "children")}</div>
      </div>
      <div class="btn-row">
        <a class="btn" href="#/families${showArchived ? "" : "?archived=1"}">
          ${showArchived ? "View Active" : "View Archived"}</a>
        ${showArchived ? "" : `<button class="btn btn-primary" id="add">+ Add Family</button>`}
      </div>
    </div>

    <div class="field">
      <input type="search" id="search" placeholder="Search by family, parent, or child name…"
             autocomplete="off">
    </div>

    <div id="results"></div>
  </div>`);

  const draw = (term = "") => {
    const t = term.trim().toLowerCase();
    const matched = !t ? visible : visible.filter((f) =>
      f.display_name?.toLowerCase().includes(t) ||
      f.last_name?.toLowerCase().includes(t) ||
      f.primary_email?.toLowerCase().includes(t) ||
      (f.parents ?? []).some((p) => `${p.first_name} ${p.last_name ?? ""}`.toLowerCase().includes(t)) ||
      (f.children ?? []).some((c) => `${c.first_name} ${c.last_name ?? ""}`.toLowerCase().includes(t)));

    if (!matched.length) {
      return render("#results", `<div class="empty">
        <h3>${t ? "No matches" : "No families yet"}</h3>
        <p>${t ? "Try a different search." : "Add the families in your co-op to get started."}</p>
      </div>`);
    }

    render("#results", matched.map((f) => {
      const kids = (f.children ?? []).filter((c) => c.active && !c.archived_at);
      const parents = (f.parents ?? [])
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((p) => `${p.first_name} ${p.last_name ?? ""}`.trim());
      return `<a class="card card-link" href="#/families/${esc(f.id)}">
        <div class="card-head" style="margin:0">
          <div>
            <h3>${esc(f.display_name)}</h3>
            <div class="small muted">${parents.length ? esc(parents.join(" · ")) : "<em>No parents listed</em>"}</div>
            <div class="small faint">${plural(kids.length, "child", "children")}${
              f.primary_email ? ` · ${esc(f.primary_email)}` : ` · <span style="color:var(--danger)">no email</span>`}</div>
          </div>
          <span class="badge ${f.archived_at ? "" : "badge-ok"}">${f.archived_at ? "Archived" : "Active"}</span>
        </div>
      </a>`;
    }).join(""));
  };

  draw();
  $("#search")?.addEventListener("input", debounce((e) => draw(e.target.value)));
  $("#add")?.addEventListener("click", addFamily);
}

async function addFamily() {
  const v = await formDialog({
    title: "Add Family",
    submitLabel: "Create Family",
    fields: [
      { name: "display_name", label: "Family name", required: true,
        placeholder: "Johnson Family", hint: "How the family appears throughout the app." },
      { name: "last_name", label: "Surname", placeholder: "Johnson" },
      { name: "primary_email", label: "Primary email", type: "email",
        hint: "Registration invitations are sent here." },
      { name: "notes", label: "Admin notes", type: "textarea",
        hint: "Only administrators see this." },
    ],
  });
  if (!v) return;

  try {
    const f = await api.createFamily(v);
    toastOk(`${f.display_name} added.`);
    go(`#/families/${f.id}`);
  } catch (e) {
    toastErr(e.message);
  }
}

// -----------------------------------------------------------------------------
// Detail
// -----------------------------------------------------------------------------
export async function detail(app, { id }) {
  const f = await api.family(id);
  const parents = (f.parents ?? []).sort((a, b) => a.sort_order - b.sort_order);
  const children = (f.children ?? []).sort((a, b) =>
    (a.birth_date ?? "9999").localeCompare(b.birth_date ?? "9999"));

  render(app, `<div class="wrap page">
    <div class="crumbs"><a href="#/families">Families</a><span>›</span>${esc(f.display_name)}</div>

    <div class="page-head">
      <div>
        <h1>${esc(f.display_name)}</h1>
        <div class="sub">
          ${f.archived_at ? `<span class="badge">Archived</span> ` : ""}
          ${f.primary_email
            ? esc(f.primary_email)
            : `<span style="color:var(--danger)">No email address — this family cannot be sent a registration link.</span>`}
        </div>
      </div>
      <div class="btn-row">
        <button class="btn" id="edit">Edit Family</button>
        <button class="btn ${f.archived_at ? "" : "btn-danger"}" id="archive">
          ${f.archived_at ? "Restore Family" : "Archive Family"}</button>
      </div>
    </div>

    ${f.notes ? `<div class="note"><strong>Notes:</strong> ${esc(f.notes)}</div>` : ""}

    <div class="card">
      <div class="card-head"><h3>Parents &amp; Guardians</h3>
        <button class="btn btn-sm" id="addparent">+ Add Parent</button></div>
      ${parents.length ? `<div class="table-scroll"><table>
        <tbody>${parents.map((p) => `<tr>
          <td>${esc(p.first_name)} ${esc(p.last_name ?? "")}</td>
          <td class="muted small">${esc(p.email ?? "")}</td>
          <td class="muted small">${esc(p.phone ?? "")}</td>
          <td class="right nowrap">
            <button class="btn btn-sm btn-ghost" data-editparent="${esc(p.id)}">Edit</button>
            <button class="btn btn-sm btn-ghost" data-delparent="${esc(p.id)}">Remove</button>
          </td></tr>`).join("")}</tbody></table></div>`
        : `<p class="muted">No parents listed yet.</p>`}
    </div>

    <div class="card">
      <div class="card-head"><h3>Children</h3>
        <button class="btn btn-sm" id="addchild">+ Add Child</button></div>
      ${children.length ? `<div class="table-scroll"><table>
        <thead><tr><th>Name</th><th>Birth date</th><th>Sex</th><th>Status</th><th></th></tr></thead>
        <tbody>${children.map((c) => `<tr${c.active && !c.archived_at ? "" : ' style="opacity:.6"'}>
          <td><strong>${esc(c.first_name)} ${esc(c.last_name ?? "")}</strong></td>
          <td class="small">${c.birth_date ? esc(fmtDate(c.birth_date))
            : `<span style="color:var(--warn)">Not set</span>`}</td>
          <td class="small">${esc(c.sex ? c.sex[0].toUpperCase() + c.sex.slice(1) : "—")}</td>
          <td>${c.archived_at ? `<span class="badge">Archived</span>`
                : c.active ? `<span class="badge badge-ok">Active</span>`
                : `<span class="badge badge-warn">Inactive</span>`}
              ${c.inactive_reason ? `<div class="tiny faint">${esc(c.inactive_reason)}</div>` : ""}</td>
          <td class="right nowrap">
            <button class="btn btn-sm btn-ghost" data-editchild="${esc(c.id)}">Edit</button>
            <button class="btn btn-sm btn-ghost" data-togglechild="${esc(c.id)}">
              ${c.active ? "Mark Inactive" : "Reactivate"}</button>
          </td></tr>`).join("")}</tbody></table></div>`
        : `<p class="muted">No children listed yet. Add them so they can be registered for classes.</p>`}
    </div>
  </div>`);

  // --- wiring ---
  $("#edit").addEventListener("click", async () => {
    const v = await formDialog({
      title: "Edit Family",
      fields: [
        { name: "display_name", label: "Family name", value: f.display_name, required: true },
        { name: "last_name", label: "Surname", value: f.last_name },
        { name: "primary_email", label: "Primary email", type: "email", value: f.primary_email },
        { name: "notes", label: "Admin notes", type: "textarea", value: f.notes },
      ],
    });
    if (!v) return;
    try { await api.updateFamily(f.id, v); toastOk("Saved."); refresh(); }
    catch (e) { toastErr(e.message); }
  });

  $("#archive").addEventListener("click", async () => {
    const archiving = !f.archived_at;
    const ok = await confirmDialog(
      archiving ? "Archive family?" : "Restore family?",
      archiving
        ? `${f.display_name} will be hidden from active lists and will not receive registration invitations. All past registrations are kept, and you can restore them at any time.`
        : `${f.display_name} will appear in active lists again.`,
      archiving ? "Archive" : "Restore", archiving);
    if (!ok) return;
    try { await api.archiveFamily(f.id, archiving); toastOk(archiving ? "Archived." : "Restored."); refresh(); }
    catch (e) { toastErr(e.message); }
  });

  $("#addparent").addEventListener("click", () => parentDialog(f.id));
  $("#addchild").addEventListener("click", () => childDialog(f.id));

  app.querySelectorAll("[data-editparent]").forEach((b) =>
    b.addEventListener("click", () =>
      parentDialog(f.id, parents.find((p) => p.id === b.dataset.editparent))));

  app.querySelectorAll("[data-delparent]").forEach((b) =>
    b.addEventListener("click", async () => {
      const p = parents.find((x) => x.id === b.dataset.delparent);
      // A parent record carries no history of its own, so removing one is the
      // rare case where an outright delete is the honest operation.
      const ok = await confirmDialog("Remove parent?",
        `Remove ${p.first_name} ${p.last_name ?? ""} from this family?`, "Remove", true);
      if (!ok) return;
      try { await api.deleteParent(p.id); toastOk("Removed."); refresh(); }
      catch (e) { toastErr(e.message); }
    }));

  app.querySelectorAll("[data-editchild]").forEach((b) =>
    b.addEventListener("click", () =>
      childDialog(f.id, children.find((c) => c.id === b.dataset.editchild))));

  app.querySelectorAll("[data-togglechild]").forEach((b) =>
    b.addEventListener("click", async () => {
      const c = children.find((x) => x.id === b.dataset.togglechild);
      if (c.active) {
        const v = await formDialog({
          title: `Mark ${c.first_name} inactive`,
          submitLabel: "Mark Inactive",
          fields: [{ name: "inactive_reason", label: "Reason (optional)",
            placeholder: "Aged out of the program",
            hint: "The child stays on all past class rosters. Only future registration is affected." }],
        });
        if (!v) return;
        try {
          await api.updateChild(c.id, { active: false, inactive_reason: v.inactive_reason });
          toastOk(`${c.first_name} marked inactive.`); refresh();
        } catch (e) { toastErr(e.message); }
      } else {
        try {
          await api.updateChild(c.id, { active: true, inactive_reason: null, archived_at: null });
          toastOk(`${c.first_name} reactivated.`); refresh();
        } catch (e) { toastErr(e.message); }
      }
    }));
}

// -----------------------------------------------------------------------------
async function parentDialog(familyId, existing = null) {
  const v = await formDialog({
    title: existing ? "Edit Parent" : "Add Parent",
    fields: [
      { name: "first_name", label: "First name", value: existing?.first_name, required: true },
      { name: "last_name", label: "Last name", value: existing?.last_name },
      { name: "email", label: "Email", type: "email", value: existing?.email },
      { name: "phone", label: "Phone", value: existing?.phone },
    ],
  });
  if (!v) return;
  try {
    if (existing) await api.updateParent(existing.id, v);
    else await api.createParent({ ...v, family_id: familyId });
    toastOk("Saved.");
    refresh();
  } catch (e) { toastErr(e.message); }
}

async function childDialog(familyId, existing = null) {
  const v = await formDialog({
    title: existing ? `Edit ${existing.first_name}` : "Add Child",
    fields: [
      { name: "first_name", label: "First name", value: existing?.first_name, required: true },
      { name: "last_name", label: "Last name", value: existing?.last_name },
      { name: "birth_date", label: "Birth date", type: "date", value: existing?.birth_date,
        hint: "Used to work out age eligibility on the semester's first class day. Age itself is never stored." },
      { name: "sex", label: "Sex", type: "select", value: existing?.sex ?? "",
        options: [{ value: "", label: "Not recorded" },
                  { value: "female", label: "Female" },
                  { value: "male", label: "Male" }],
        hint: "Only used where a class restricts by sex." },
      { name: "notes", label: "Admin notes", type: "textarea", value: existing?.notes },
    ],
  });
  if (!v) return;
  try {
    if (existing) await api.updateChild(existing.id, v);
    else await api.createChild({ ...v, family_id: familyId });
    toastOk("Saved.");
    refresh();
  } catch (e) { toastErr(e.message); }
}
