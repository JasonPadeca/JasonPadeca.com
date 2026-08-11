// =============================================================================
// Class proposals, from the leadership's side.
//
// This screen does one job: put what somebody wrote in front of the people who
// will discuss it, and get out of the way. There is no scoring, no ranking, no
// suggested decision. Whether the co-op can run a class depends on whether
// anybody can teach it, whether there is a room free that hour, and whether the
// person proposing it has the patience for eleven nine-year-olds — none of
// which is in the form.
//
// So a proposal is either waiting to be discussed or it has been filed. The
// outcome is recorded when it is filed, because somebody will ask next spring
// why a class did not run and "we declined it, here is the note" is a better
// answer than silence.
// =============================================================================

import { api } from "../../assets/api.js";
import {
  esc, $, render, fmtDate, relTime, plural, toastOk, toastErr, modal, formDialog,
} from "../../assets/ui.js";
import { fieldsFor } from "../../assets/proposal-fields.js";
import { refresh } from "../app.js";

export async function show(app) {
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const archived = params.get("archived") === "1";

  let rows = [];
  try {
    rows = await api.proposals({ archived });
  } catch (e) {
    return render(app, `<div class="wrap page">
      <div class="note note-danger">${esc(e.message)}</div>
      <p class="muted mt">If this says the table does not exist, the database
      update that adds it has not been run yet.</p></div>`);
  }

  render(app, `<div class="wrap page">
    <div class="page-head">
      <div>
        <h1>Class proposals</h1>
        <div class="sub">${archived
          ? plural(rows.length, "filed proposal")
          : `${plural(rows.length, "proposal")} waiting to be discussed`}</div>
      </div>
      <div class="btn-row">
        <a class="btn" href="#/proposals${archived ? "" : "?archived=1"}">
          ${archived ? "Show what is waiting" : "Show what has been filed"}</a>
      </div>
    </div>

    ${rows.length ? `<div class="cards">${rows.map(card).join("")}</div>`
      : `<div class="empty">
          <h3>${archived ? "Nothing filed yet" : "Nothing waiting"}</h3>
          <p>${archived
            ? "Proposals you have discussed and filed will appear here."
            : "Proposals sent by families will appear here."}</p>
        </div>`}
  </div>`);

  app.querySelectorAll("[data-open]").forEach((b) =>
    b.addEventListener("click", () => openOne(rows.find((r) => r.id === b.dataset.open))));
}

function card(p) {
  const badge = p.kind === "student"
    ? `<span class="badge">From a student</span>`
    : `<span class="badge">From a parent</span>`;

  const outcome = p.outcome === "accepted" ? `<span class="badge badge-ok">Accepted</span>`
    : p.outcome === "declined" ? `<span class="badge badge-danger">Declined</span>`
    : p.status === "archived" ? `<span class="badge">Filed</span>` : "";

  return `<div class="card">
    <div class="card-head">
      <div>
        <h3>${esc(p.title)}</h3>
        <div class="sub">${badge} ${outcome}
          · ${esc(p.age_range)} · homework: ${esc(p.homework.toLowerCase())}
          · sent ${esc(relTime(p.submitted_at))}</div>
      </div>
      <button class="btn btn-sm" data-open="${esc(p.id)}">Read it</button>
    </div>
    <p class="clamp">${esc(p.description ?? "")}</p>
  </div>`;
}

function openOne(p) {
  if (!p) return;

  // Every question, in the order it was asked, including the ones left blank.
  // A blank answer is information — "no, we do not need the printer" and "they
  // did not get that far" look the same in a summary that hides empties, and
  // they are not the same thing at all.
  const rows = fieldsFor(p.kind).map((f) => {
    const v = p[f.name];
    return `<div class="qa">
      <div class="q">${esc(f.label)}</div>
      <div class="a">${v ? esc(v) : `<span class="faint">Left blank</span>`}</div>
    </div>`;
  }).join("");

  modal({
    title: p.title,
    wide: true,
    body: `
      <div class="sub mb">
        ${p.kind === "student" ? "A student's proposal" : "A parent's proposal"}
        · sent ${esc(fmtDate(p.submitted_at))}
        ${p.archived_at ? ` · filed ${esc(fmtDate(p.archived_at))}` : ""}
      </div>
      ${p.admin_notes ? `<div class="note mb"><strong>Your note:</strong>
        ${esc(p.admin_notes)}</div>` : ""}
      ${rows}`,
    buttons: p.status === "archived"
      ? [{ value: "reopen", label: "Put back in the list" },
         { value: null, label: "Close" }]
      : [{ value: "accepted", label: "File as accepted", class: "btn-primary" },
         { value: "declined", label: "File as declined" },
         { value: null, label: "Close" }],
  }).then(async (choice) => {
    if (!choice) return;
    try {
      if (choice === "reopen") {
        await api.reopenProposal(p.id);
        toastOk("Back in the list.");
      } else {
        const answers = await formDialog({
          title: choice === "accepted" ? "File as accepted" : "File as declined",
          submitLabel: "File it",
          fields: [{
            name: "notes", label: "Anything worth remembering?", type: "textarea",
            hint: "Optional. This is what somebody reads next year when they ask " +
                  "why this class did or did not run.",
          }],
        });
        // Cancelled — leave it where it is rather than filing it silently.
        if (!answers) return;

        await api.archiveProposal(p.id, choice, answers.notes || null);
        toastOk(choice === "accepted"
          ? "Filed as accepted. Add the class under Semesters when you are ready."
          : "Filed.");
      }
      await refresh();
    } catch (e) {
      toastErr(e.message);
    }
  });
}
