// =============================================================================
// Settings (§43), administrator management (§5.10), and the audit log (§5.11).
//
// Only settings an administrator would actually change live here. Anything that
// needs a secret — the Brevo key, the service role key — is in Supabase, not in
// a form on a web page.
// =============================================================================

import { api } from "../../assets/api.js";
import {
  esc, $, render, fmtDateTime, relTime, toastOk, toastErr,
  formDialog, confirmDialog,
} from "../../assets/ui.js";
import { refresh, ADMIN } from "../app.js";

export async function show(app) {
  const [settings, admins, status] = await Promise.all([
    api.settings(),
    api.admins().catch(() => []),
    api.systemStatus().catch(() => null),
  ]);

  const isOwner = ADMIN?.role === "owner";

  render(app, `<div class="wrap page">
    <div class="page-head"><div><h1>Settings</h1></div></div>

    <div class="card">
      <div class="card-head"><h3>Program</h3>
        <button class="btn btn-sm" id="editprogram">Edit</button></div>
      <div class="table-scroll"><table><tbody>
        ${row("Program name", settings.program_name)}
        ${row("Registration link address", settings.registration_base_url,
              "The address families are sent. Must point at this site's /coop/register/ page.")}
        ${row("Sending address", settings.from_email,
              "The From address on invitation and confirmation emails. Must be verified with Brevo.")}
        ${row("Sender name", settings.from_name)}
        ${row("Reply-to address", settings.reply_to_email,
              "Where replies from families go — usually the co-op's normal inbox.")}
        ${row("Time zone", settings.timezone)}
      </tbody></table></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Registration behaviour</h3>
        <button class="btn btn-sm" id="editbehaviour">Edit</button></div>
      <div class="table-scroll"><table><tbody>
        ${row("Ineligible classes",
              settings.show_ineligible_classes
                ? "Shown, dimmed, with the reason"
                : "Hidden from families",
              "How a class a child does not qualify for appears on the registration page.")}
        ${row("Families may change their registration",
              settings.allow_family_edits ? "Yes, while registration is open" : "No — administrators only",
              "Whether a family can reopen their link and adjust choices after submitting.")}
        ${row("Normal program ages",
              settings.normal_program_age_min != null || settings.normal_program_age_max != null
                ? `${settings.normal_program_age_min ?? "any"} – ${settings.normal_program_age_max ?? "any"}`
                : null,
              "Only used to flag children outside the usual range. Nobody is removed automatically.")}
      </tbody></table></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Administrators</h3>
        ${isOwner ? `<button class="btn btn-sm" id="addadmin">+ Add Administrator</button>` : ""}</div>
      ${isOwner ? "" : `<p class="small muted mb">Only the owner can change this list.</p>`}
      <div class="table-scroll"><table>
        <thead><tr><th>Person</th><th>Email</th><th>Role</th><th>Status</th>${isOwner ? "<th></th>" : ""}</tr></thead>
        <tbody>${admins.map((a) => `<tr>
          <td>${esc(a.display_name ?? "—")}${a.id === ADMIN?.id ? ` <span class="badge">You</span>` : ""}</td>
          <td class="small muted">${esc(a.email)}</td>
          <td><span class="badge ${a.role === "owner" ? "badge-accent" : ""}">${esc(a.role)}</span></td>
          <td>${a.active ? `<span class="badge badge-ok">Active</span>`
                         : `<span class="badge">Disabled</span>`}
              ${a.auth_user_id ? "" : `<div class="tiny faint">Has not signed in yet</div>`}</td>
          ${isOwner ? `<td class="right nowrap">
            ${a.id === ADMIN?.id ? `<span class="tiny faint">—</span>`
              : `<button class="btn btn-sm btn-ghost" data-toggleadmin="${esc(a.id)}">
                   ${a.active ? "Disable" : "Enable"}</button>`}
          </td>` : ""}
        </tr>`).join("")}</tbody></table></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>System</h3>
        <a class="btn btn-sm" href="#/audit">View Audit Log</a></div>
      <div class="table-scroll"><table><tbody>
        ${row("Backend status", status ? "OK" : "Unknown")}
        ${row("Last keepalive", status?.last_keepalive_at
          ? `${relTime(status.last_keepalive_at)} (${fmtDateTime(status.last_keepalive_at)})`
          : "Never — check the GitHub Action")}
      </tbody></table></div>
    </div>
  </div>`);

  $("#editprogram").addEventListener("click", async () => {
    const v = await formDialog({
      title: "Program settings",
      fields: [
        { name: "program_name", label: "Program name", value: settings.program_name, required: true },
        { name: "registration_base_url", label: "Registration link address",
          value: settings.registration_base_url ?? `${location.origin}/coop/register/`,
          hint: "Families' links are built from this. It must end at /coop/register/." },
        { name: "from_email", label: "Sending address", type: "email", value: settings.from_email,
          hint: "Must be an address verified in Brevo, or mail will not go out." },
        { name: "from_name", label: "Sender name", value: settings.from_name },
        { name: "reply_to_email", label: "Reply-to address", type: "email", value: settings.reply_to_email },
        { name: "timezone", label: "Time zone", value: settings.timezone,
          hint: "IANA name, e.g. America/Chicago." },
      ],
    });
    if (!v) return;
    try { await api.updateSettings(v); toastOk("Saved."); refresh(); }
    catch (e) { toastErr(e.message); }
  });

  $("#editbehaviour").addEventListener("click", async () => {
    const v = await formDialog({
      title: "Registration behaviour",
      fields: [
        { name: "show_ineligible_classes", type: "checkbox", value: settings.show_ineligible_classes,
          checkLabel: "Show ineligible classes to families, dimmed, with the reason",
          hint: "Unticked, a child simply does not see classes they cannot take." },
        { name: "allow_family_edits", type: "checkbox", value: settings.allow_family_edits,
          checkLabel: "Families may change their registration while registration is open",
          hint: "Unticked, a submitted registration is read-only and changes go through an administrator." },
        { name: "normal_program_age_min", label: "Youngest normal age", type: "number", min: 0,
          value: settings.normal_program_age_min },
        { name: "normal_program_age_max", label: "Oldest normal age", type: "number", min: 0,
          value: settings.normal_program_age_max },
      ],
    });
    if (!v) return;
    try { await api.updateSettings(v); toastOk("Saved."); refresh(); }
    catch (e) { toastErr(e.message); }
  });

  $("#addadmin")?.addEventListener("click", async () => {
    const v = await formDialog({
      title: "Add administrator",
      submitLabel: "Add",
      fields: [
        { name: "email", label: "Google address", type: "email", required: true,
          hint: "Must be the Google account they will sign in with." },
        { name: "display_name", label: "Name", hint: "Optional — filled in when they first sign in." },
        { name: "role", label: "Role", type: "select", value: "admin",
          options: [{ value: "admin", label: "Administrator" },
                    { value: "owner", label: "Owner — can also manage this list" }] },
      ],
    });
    if (!v) return;
    try { await api.createAdmin(v); toastOk(`${v.email} can now sign in.`); refresh(); }
    catch (e) { toastErr(e.message); }
  });

  app.querySelectorAll("[data-toggleadmin]").forEach((b) =>
    b.addEventListener("click", async () => {
      const a = admins.find((x) => x.id === b.dataset.toggleadmin);
      const disabling = a.active;
      const ok = await confirmDialog(
        disabling ? "Disable this administrator?" : "Enable this administrator?",
        disabling
          ? `${a.email} will immediately lose access to everything here. Their record and their history are kept.`
          : `${a.email} will be able to sign in again.`,
        disabling ? "Disable" : "Enable", disabling);
      if (!ok) return;
      try { await api.updateAdmin(a.id, { active: !disabling }); toastOk("Saved."); refresh(); }
      catch (e) { toastErr(e.message); }
    }));
}

function row(label, value, hint) {
  return `<tr>
    <td style="width:38%"><strong>${esc(label)}</strong>
      ${hint ? `<div class="tiny faint">${esc(hint)}</div>` : ""}</td>
    <td>${value ? esc(value) : `<span style="color:var(--warn)">Not set</span>`}</td>
  </tr>`;
}

// =============================================================================
// Audit log (§5.11)
// =============================================================================
export async function audit(app) {
  const entries = await api.auditLog(200);

  render(app, `<div class="wrap page">
    <div class="crumbs"><a href="#/settings">Settings</a><span>›</span>Audit Log</div>
    <div class="page-head"><div>
      <h1>Audit Log</h1>
      <div class="sub">The last ${entries.length} recorded actions</div>
    </div></div>

    ${entries.length ? `<div class="table-scroll"><table>
      <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
      <tbody>${entries.map((e) => `<tr>
        <td class="small nowrap">${esc(fmtDateTime(e.created_at))}</td>
        <td class="small">${esc(e.actor_label ?? e.actor_type)}</td>
        <td class="small">${esc(describe(e.action))}</td>
        <td class="tiny faint">${esc(summarise(e.details))}</td>
      </tr>`).join("")}</tbody></table></div>`
    : `<div class="empty"><h3>Nothing logged yet</h3></div>`}
  </div>`);
}

const ACTIONS = {
  family_registration_submitted: "Family submitted a registration",
  admin_placed_child: "Administrator added a student",
  admin_placed_child_with_override: "Administrator added a student (override)",
  admin_changed_registration_status: "Administrator changed a registration",
  waitlist_promoted: "Promoted from a waitlist",
  registration_opened: "Registration opened",
  invitation_resent: "Invitation resent",
  invitation_reissued: "Invitation reissued",
  invitation_revoked: "Invitation revoked",
  confirmation_email_failed: "Confirmation email failed",
};

const describe = (a) => ACTIONS[a] ?? a;

function summarise(details) {
  if (!details || typeof details !== "object") return "";
  const bits = [];
  if (details.invited != null) bits.push(`${details.invited} invited`);
  if (details.failed) bits.push(`${details.failed} failed`);
  if (details.reason) bits.push(details.reason);
  if (details.from && details.to) bits.push(`${details.from} → ${details.to}`);
  if (details.error) bits.push(details.error);
  if (Array.isArray(details.results)) bits.push(`${details.results.length} selections`);
  return bits.join(" · ");
}
