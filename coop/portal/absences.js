// =============================================================================
// Absences, as a parent sees them.
//
// The whole interaction is one screen: which child, which day, all of it or
// part. No wizard, no confirmation step — a parent doing this is usually doing
// it one-handed at seven in the morning having just decided a child is too
// unwell to go.
//
// Dates are offered as a list of real meeting days rather than a date picker.
// A calendar invites picking a Tuesday when the co-op meets on Thursday, and
// nobody discovers the mistake until the register does not match.
// =============================================================================

import { api } from "../assets/api.js";
import { esc, $, render, fmtDate, toastOk, toastErr, plural } from "../assets/ui.js";

/**
 * Class days still to come, from the co-op's actual calendar.
 *
 * This used to be computed from semesters.meeting_weekday, which could only ever
 * say "every Thursday" — it had no way to know the co-op is not meeting on
 * Thanksgiving, and would happily offer a parent a day with no class on it.
 * meeting_dates knows, so cancelled weeks are left out entirely.
 */
export function upcomingMeetings(meetings, limit = 20) {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return (meetings ?? [])
    .filter((m) => !m.cancelled && m.meets_on >= today)
    .slice(0, limit);
}

export function render_(container, { children, semester, periods, absences, meetings, onChange }) {
  const dates = upcomingMeetings(meetings);
  const upcoming = absences ?? [];

  render(container, `
    <div class="card">
      <div class="card-head">
        <h3>Absences</h3>
        ${dates.length ? `<button class="btn btn-sm btn-primary" id="addabsence">
          + Report an absence</button>` : ""}
      </div>

      ${!semester ? `<p class="muted">No semester is running at the moment.</p>`
        : !dates.length ? `<p class="muted">No class days left this term.</p>`
        : upcoming.length ? `<div class="table-scroll"><table>
            <thead><tr><th>Who</th><th>When</th><th>Missing</th><th></th></tr></thead>
            <tbody>${upcoming.map((a) => {
              const named = (a.absence_periods ?? [])
                .map((ap) => periods.find((p) => p.id === ap.period_id))
                .filter(Boolean)
                .sort((x, y) => x.period_number - y.period_number);
              return `<tr>
                <td><strong>${esc(a.children?.first_name ?? "")}</strong></td>
                <td>${esc(fmtDate(a.meeting_dates?.meets_on))}</td>
                <td class="small">${a.whole_day
                  ? "The whole day"
                  : named.length
                    ? esc(named.map((p) => p.display_name || `Period ${p.period_number}`).join(", "))
                    : "<span class='faint'>—</span>"}
                  ${a.reason ? `<div class="tiny faint">${esc(a.reason)}</div>` : ""}</td>
                <td class="right nowrap">
                  <button class="btn btn-sm btn-ghost" data-cancel="${esc(a.id)}">Remove</button>
                </td>
              </tr>`;
            }).join("")}</tbody></table></div>`
          : `<p class="muted">Nothing reported. Let us know here if a child will
             miss a class day, and their teachers will see it.</p>`}
    </div>`);

  $("#addabsence")?.addEventListener("click", () =>
    openForm({ children, semester, periods, dates, onChange }));

  container.querySelectorAll("[data-cancel]").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await api.cancelAbsence(b.dataset.cancel);
        toastOk("Removed.");
        onChange();
      } catch (e) {
        toastErr(e.message);
        b.disabled = false;
      }
    }));
}

function openForm({ children, semester, periods, dates, onChange }) {
  const dlg = document.createElement("dialog");
  dlg.className = "modal";
  dlg.innerHTML = `
    <form method="dialog" id="absform">
      <h3>Report an absence</h3>

      <div class="field">
        <label for="a-child">Who</label>
        <select id="a-child" required>
          ${children.map((c) => `<option value="${esc(c.id)}">
            ${esc(c.first_name)} ${esc(c.last_name ?? "")}</option>`).join("")}
        </select>
      </div>

      <div class="field">
        <label for="a-date">Which day</label>
        <select id="a-date" required>
          ${dates.map((m) => `<option value="${esc(m.meets_on)}">${esc(fmtDate(m.meets_on))}${m.note ? ` — ${esc(m.note)}` : ""}</option>`).join("")}
        </select>
      </div>

      <div class="field">
        <label>How much of it</label>
        <label class="check">
          <input type="radio" name="extent" value="whole" checked>
          <span>The whole day</span>
        </label>
        <label class="check">
          <input type="radio" name="extent" value="part">
          <span>Only part of it</span>
        </label>
      </div>

      <div class="field" id="periodpick" hidden>
        <label>Which periods will they miss?</label>
        ${periods.map((p) => `<label class="check">
          <input type="checkbox" name="period" value="${esc(p.id)}">
          <span>${esc(p.display_name || `Period ${p.period_number}`)}</span>
        </label>`).join("")}
      </div>

      <div class="field">
        <label for="a-reason">Anything we should know? <span class="faint">(optional)</span></label>
        <input type="text" id="a-reason" maxlength="200" placeholder="Dentist, family trip…">
      </div>

      <div class="modal-actions">
        <button class="btn" value="cancel" type="submit">Cancel</button>
        <button class="btn btn-primary" id="a-save" type="button">Report it</button>
      </div>
    </form>`;

  document.body.appendChild(dlg);
  dlg.showModal();

  const pick = dlg.querySelector("#periodpick");
  dlg.querySelectorAll('input[name="extent"]').forEach((r) =>
    r.addEventListener("change", () => {
      pick.hidden = dlg.querySelector('input[name="extent"]:checked').value !== "part";
    }));

  dlg.querySelector("#a-save").addEventListener("click", async () => {
    const childId = dlg.querySelector("#a-child").value;
    const date = dlg.querySelector("#a-date").value;
    const whole = dlg.querySelector('input[name="extent"]:checked').value === "whole";
    const periodIds = [...dlg.querySelectorAll('input[name="period"]:checked')].map((i) => i.value);
    const reason = dlg.querySelector("#a-reason").value.trim() || null;

    if (!whole && !periodIds.length) {
      return toastErr("Choose at least one period, or report the whole day.");
    }

    const btn = dlg.querySelector("#a-save");
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const res = await api.reportAbsence(childId, date, whole, periodIds, reason);
      if (!res?.ok) throw new Error(res?.message ?? "That could not be saved.");
      dlg.close();
      dlg.remove();
      toastOk("Thank you — their teachers will see it.");
      onChange();
    } catch (e) {
      toastErr(e.message);
      btn.disabled = false;
      btn.textContent = "Report it";
    }
  });

  dlg.addEventListener("close", () => dlg.remove());
}
