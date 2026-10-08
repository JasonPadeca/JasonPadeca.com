// =============================================================================
// Asking parents to help.
//
// Everybody, or a few, or one. The list is parents rather than families on
// purpose: two parents at one address are two people who might each take a
// class, and an email addressed to "the Hershberger Family" asks neither of
// them in particular.
//
// Who has already answered is shown beside each name, because the second send
// is always the awkward one — chasing people who already replied is how a
// co-op teaches its members to ignore the co-op's emails.
// =============================================================================

import { api } from "../../assets/api.js";
import {
  esc, $, $$, render, plural, toastOk, toastErr, confirmDialog,
} from "../../assets/ui.js";

export async function show(app) {
  let semesters = [];
  try {
    semesters = await api.semesters();
  } catch (e) {
    return render(app, `<div class="wrap page">
      <div class="note note-danger">${esc(e.message)}</div></div>`);
  }

  const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const semesterId = q.get("semester") ?? semesters[0]?.id;
  const semester = semesters.find((s) => s.id === semesterId);
  if (!semester) {
    return render(app, `<div class="wrap page"><div class="empty">
      <h3>No semesters</h3><p><a href="#/helpers">Back</a></p></div></div>`);
  }

  let board;
  try {
    board = await api.helperBoard(semester.id);
  } catch (e) {
    return render(app, `<div class="wrap page">
      <div class="note note-danger">${esc(e.message)}</div></div>`);
  }

  const parents = (board.parents ?? []).filter((p) => p.email);
  const noEmail = (board.parents ?? []).length - parents.length;

  render(app, `<div class="wrap page">
    <div class="page-head">
      <div>
        <div class="crumbs"><a href="#/helpers?semester=${esc(semester.id)}">Class helpers</a>
          <span>›</span>Email parents</div>
        <h1>Ask parents to help</h1>
        <div class="sub">${esc(semester.name)}</div>
      </div>
    </div>

    <div class="note">
      Everybody you tick gets a short note asking which classes they would help
      with, and a link that signs them in and takes them straight to the list.
      ${noEmail ? `<strong>${plural(noEmail, "parent")}</strong> cannot be
        emailed — no address on file.` : ""}
    </div>

    <div class="card mt">
      <div class="card-head">
        <h3>Who to ask</h3>
        <div class="btn-row">
          <button class="btn btn-sm" id="all">Everybody</button>
          <button class="btn btn-sm" id="silent">Only those who have not replied</button>
          <button class="btn btn-sm" id="none">Nobody</button>
        </div>
      </div>

      <div class="table-scroll"><table>
        <thead><tr><th style="width:2.5rem"></th><th>Parent</th><th>Family</th>
          <th>Email</th><th>Replied</th></tr></thead>
        <tbody>${parents.map((p) => `<tr>
          <td><input type="checkbox" class="pick" value="${esc(p.id)}" checked></td>
          <td><strong>${esc(p.name)}</strong></td>
          <td class="muted">${esc(p.family)}</td>
          <td class="muted small">${esc(p.email)}</td>
          <td>${p.replied
            ? `<span class="badge badge-ok">Yes</span>`
            : `<span class="muted">—</span>`}</td>
        </tr>`).join("")}</tbody>
      </table></div>
    </div>

    <div class="btn-row mt2">
      <button class="btn btn-primary" id="send">Send</button>
      <span class="muted" id="count"></span>
    </div>
  </div>`);

  const picks = () => $$(".pick", app).filter((c) => c.checked);
  const tally = () => {
    $("#count", app).textContent = `${plural(picks().length, "parent")} selected`;
  };
  tally();

  $$(".pick", app).forEach((c) => c.addEventListener("change", tally));
  $("#all", app).addEventListener("click", () => {
    $$(".pick", app).forEach((c) => { c.checked = true; }); tally();
  });
  $("#none", app).addEventListener("click", () => {
    $$(".pick", app).forEach((c) => { c.checked = false; }); tally();
  });
  $("#silent", app).addEventListener("click", () => {
    $$(".pick", app).forEach((c, i) => { c.checked = !parents[i].replied; }); tally();
  });

  $("#send", app).addEventListener("click", async () => {
    const ids = picks().map((c) => c.value);
    if (!ids.length) return toastErr("Nobody is selected.");

    const ok = await confirmDialog(
      `Email ${plural(ids.length, "parent")}?`,
      `They will be asked which classes they would help with in ${semester.name}.`,
      "Send");
    if (!ok) return;

    const btn = $("#send", app);
    btn.disabled = true;
    try {
      const res = await api.sendHelperRequest(semester.id, ids);
      if (!res?.ok) throw new Error(res?.error ?? "Could not send.");
      if (res.failed?.length) {
        toastErr(`Sent to ${res.sent}. Could not reach: ` +
          res.failed.map((f) => f.parent).join(", "));
      } else {
        toastOk(`Sent to ${plural(res.sent, "parent")}.`);
      }
    } catch (e) {
      toastErr(e.message);
    } finally {
      btn.disabled = false;
    }
  });
}
