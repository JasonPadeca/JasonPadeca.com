// =============================================================================
// Family portal — sign-in.
//
// One front door for everybody. A parent signs in and sees their family; an
// administrator who is also a parent sees the same thing plus a way through to
// the administration side. Authorization is a table lookup, not a separate
// login, which is why "gate it to some but not others" needs no new machinery.
//
// Sign-in is a code emailed to the address the co-op has on file. There is no
// sign-in link, deliberately: everyone using this is on a phone, and tapping a
// link inside the Gmail or Mail app opens it in that app's own browser, which
// signs the parent in THERE. They close Gmail, open Chrome the next day, and
// are signed out with no idea why. A code goes into whatever browser they are
// already standing in.
//
// After the first sign-in the session persists and renews itself, so this page
// is a door, not a turnstile — see persistSession in api.js.
// =============================================================================

import { auth, api, IS_CONFIGURED, needsFresh } from "../assets/api.js";
import { esc, $, render, toastErr, plural } from "../assets/ui.js";
import * as Absences from "./absences.js";
import * as Week from "./week.js";
import * as Proposals from "./proposals.js";
import * as RegForm from "./registration-form.js";
import * as FamilySetup from "./family-setup.js";
import { REGISTRATION_STATUS } from "../assets/proposal-fields.js";

const app = document.getElementById("app");

// Remembered only between the two steps of one sign-in, so a reload during
// "check your email" does not lose which address was used.
const PENDING_EMAIL = "coop.portal.pending-email";

let state = { session: null, me: null };

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------
async function start() {
  // See needsFresh in api.js: reload once if the browser handed us a cached
  // copy from before these existed, rather than failing with "not a function".
  if (needsFresh(["familyWeek", "familySetup", "familyVolunteering"])) return;

  if (!IS_CONFIGURED) {
    return render(app, `<div class="wrap page"><div class="note note-danger">
      This site is not configured yet. See coop/SETUP.md.</div></div>`);
  }

  try {
    state.session = await auth.session();
  } catch (e) {
    return signedOut(e.message);
  }

  if (!state.session) {
    // Everyone here is on a phone, and the flow requires leaving this page for
    // the mail app and coming back. Phones discard background tabs under memory
    // pressure, so coming back often means a fresh load — and landing on an
    // empty email box, having just been sent a code, is maddening.
    //
    // If a code was requested and not yet used, resume where they left off.
    const pending = localStorage.getItem(PENDING_EMAIL);
    return pending ? awaitingCode(pending) : signedOut();
  }

  try {
    state.me = await auth.establishSession();
  } catch (e) {
    return signedOut(e.message);
  }

  localStorage.removeItem(PENDING_EMAIL);

  if (!state.me?.recognised) return notRecognised();

  // Where does this person belong?
  //
  // Somebody who only teaches — the grandfather taking the automotive class —
  // has no family page to look at, and showing him an empty one would be
  // baffling. He goes straight to teaching and need never learn family pages
  // exist. A parent who also teaches lands on their family page with a
  // Teaching button, because that is the page they came for.
  const hasFamily = (state.me.families ?? []).length > 0;
  const teaches = (state.me.teaches ?? []).length > 0;

  if (!hasFamily && teaches) {
    location.replace("../teacher/");
    return;
  }
  if (!hasFamily && !teaches && state.me.is_admin) {
    location.replace("../admin/");
    return;
  }

  return home();
}

// -----------------------------------------------------------------------------
// Signed out — step 1: ask for the address
// -----------------------------------------------------------------------------
function signedOut(errorMessage) {
  const pending = localStorage.getItem(PENDING_EMAIL);

  render(app, `<div class="signin-page">
    <div class="signin-card">
      <img src="../assets/koinonia-logo.jpg" alt="" class="signin-mark" width="72" height="72">
      <h1>Koinonia Homeschool Group</h1>
      <p class="signin-sub">Sign in with the email address the co-op has on file for your family.</p>

      ${errorMessage ? `<div class="note note-danger">${esc(errorMessage)}</div>` : ""}

      <form id="emailform" novalidate>
        <div class="field">
          <label for="email">Email address</label>
          <input type="email" id="email" name="email" required autocomplete="email"
                 autocapitalize="off" spellcheck="false"
                 value="${esc(pending ?? "")}" placeholder="you@example.com">
        </div>
        <button class="btn btn-primary btn-block" type="submit" id="send">
          Email me a code
        </button>
      </form>

      <p class="signin-foot">No password required. You will stay signed in on this
        device, so you should only have to do this once.</p>
    </div>
  </div>`);

  // After a rejected address, put the cursor in the field with the text
  // selected, so correcting it is one action rather than a hunt.
  if (errorMessage) {
    const field = $("#email");
    field.focus();
    field.select();
  }

  $("#emailform").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#email").value.trim();
    if (!email || !email.includes("@")) return toastErr("Enter your email address.");

    const btn = $("#send");
    btn.disabled = true;
    btn.textContent = "Sending…";
    try {
      await auth.sendSignInEmail(email);
      localStorage.setItem(PENDING_EMAIL, email);
      awaitingCode(email);
    } catch (err) {
      // Rendered into the card rather than raised as a toast. The message that
      // matters here is "we do not have that address", which a parent needs to
      // read, think about, and act on — a notice that fades after a few seconds
      // is the wrong shape for it. Re-rendering also puts what they typed back
      // in the field, so the typo is in front of them while they fix it.
      localStorage.setItem(PENDING_EMAIL, email);
      signedOut(err.message);
    }
  });
}

// -----------------------------------------------------------------------------
// Signed out — step 2: the code
//
// There is no sign-in link, on purpose. Everyone using this is on a phone, and
// tapping a link inside the Gmail or Mail app opens it in that app's own
// built-in browser — which signs the parent in THERE. They close Gmail, open
// Chrome the next day, and are signed out with no idea why.
//
// Offering both meant explaining that, which is a paragraph of apology on a
// sign-in screen. Removing the link removes the failure and the explanation
// together: fetch the code, type it here, done. One path, in the browser they
// actually use.
// -----------------------------------------------------------------------------
function awaitingCode(email) {
  render(app, `<div class="signin-page">
    <div class="signin-card">
      <img src="../assets/koinonia-logo.jpg" alt="" class="signin-mark" width="72" height="72">
      <h1>Check your email</h1>
      <p class="signin-sub">We have sent a code to <strong>${esc(email)}</strong>.
        Fetch it and type it in below — this page will wait.</p>

      <form id="codeform" novalidate>
        <div class="field">
          <label for="code">Code from the email</label>
          <input type="text" id="code" name="code" inputmode="numeric" pattern="[0-9]*"
                 autocomplete="one-time-code" maxlength="10" class="code-input"
                 aria-describedby="codehelp">
        </div>
        <button class="btn btn-primary btn-block" type="submit" id="verify">Sign in</button>
      </form>

      <p class="signin-foot">
        Nothing arrived? Check your spam folder, or
        <a href="#" id="resend">send another code</a>.<br>
        <a href="#" id="again">Use a different address</a>.
      </p>
    </div>
  </div>`);

  const input = $("#code");
  input.focus();

  // The code length is a Supabase project setting, not a constant — this one
  // sends eight digits, and an earlier version of this page hard-coded six,
  // silently truncating the code and failing every time. So: accept whatever
  // arrives, and never guess when it is complete from a length.
  input.addEventListener("input", () => {
    input.value = input.value.replace(/\D/g, "").slice(0, 10);
  });

  // Pasting the whole code is the common path — it is sitting in an email two
  // taps away. That IS a complete code, so submit it.
  input.addEventListener("paste", () => {
    setTimeout(() => {
      input.value = input.value.replace(/\D/g, "").slice(0, 10);
      if (input.value.length >= 6) $("#codeform").requestSubmit();
    }, 0);
  });

  $("#codeform").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = input.value.trim();
    if (code.length < 6) return toastErr("Enter the whole code from the email.");

    const btn = $("#verify");
    btn.disabled = true;
    btn.textContent = "Signing in…";
    try {
      await auth.verifyCode(email, code);
      await start();
    } catch (err) {
      toastErr(err.message);
      btn.disabled = false;
      btn.textContent = "Sign in";
      input.select();
    }
  });

  $("#resend").addEventListener("click", async (e) => {
    e.preventDefault();
    const link = e.target;
    link.textContent = "sending…";
    try {
      await auth.sendSignInEmail(email);
      link.textContent = "another code sent";
      input.value = "";
      input.focus();
    } catch (err) {
      // Most often the hourly cap, which "try again" does not solve. Shown as
      // a toast rather than re-rendering, because the code from the FIRST email
      // is probably still valid and still in their inbox — throwing away the
      // input they are standing in front of would be the wrong help.
      link.textContent = "send another code";
      toastErr(err.message);
    }
  });

  $("#again").addEventListener("click", (e) => {
    e.preventDefault();
    localStorage.removeItem(PENDING_EMAIL);
    signedOut();
  });
}

// -----------------------------------------------------------------------------
// Signed in, but the address is not on any family record
// -----------------------------------------------------------------------------
function notRecognised() {
  render(app, `<div class="signin-page">
    <div class="signin-card">
      <img src="../assets/koinonia-logo.jpg" alt="" class="signin-mark" width="72" height="72">
      <h1>We do not recognise that address</h1>
      <p class="signin-sub">You signed in as <strong>${esc(state.me?.email ?? "")}</strong>,
        but it is not on file for any family in the co-op.</p>
      <p class="signin-sub">If your family uses a different address for co-op business,
        sign in with that one. Otherwise ask an administrator to add it to your
        family record.</p>
      <button class="btn btn-block" id="out">Sign out and try another address</button>
    </div>
  </div>`);

  $("#out").addEventListener("click", async () => {
    await auth.signOut();
    localStorage.removeItem(PENDING_EMAIL);
    location.reload();
  });
}

// -----------------------------------------------------------------------------
// Signed in
//
// Three pages behind one door: what is happening this week, where the family
// stands, and proposing a class. They began as one long page, which worked
// with two sections and stopped working at four — a parent on a phone had to
// scroll past the calendar and the absence form to find out whether they were
// registered at all.
//
// Routing is by hash, because GitHub Pages serves static files. The week arrows
// already put "on=…" in the hash with no leading slash, so anything that does
// not begin with "/" means the home page with a week chosen — exactly what it
// meant before this router existed.
// -----------------------------------------------------------------------------
const PAGES = [
  ["/",             "This week"],
  ["/family",       "Your family"],
  ["/registration", "Registration"],
  ["/proposals",    "Propose a class"],
];

function currentPath() {
  const h = (location.hash || "").replace(/^#/, "").split("?")[0];
  if (!h.startsWith("/")) return "/";
  return PAGES.some(([p]) => p === h) ? h : "/";
}

let shownPath = null;

async function route() {
  const path = currentPath();

  // Same page, different week: the arrows change the hash but not the page, so
  // redraw that one section rather than refetching the lot.
  if (path === shownPath) {
    if (path === "/") await redrawWeek();
    return;
  }
  shownPath = path;

  if (path === "/family") return familyPage();
  if (path === "/registration") return registrationPage();
  if (path === "/proposals") return proposalsPage();
  return home();
}

/** The chrome every signed-in page shares. */
function shell(path, body) {
  const families = state.me.families ?? [];

  render(app, `
    <nav class="topbar">
      <div class="wrap">
        <a class="brand" href="#/">
          <img src="../assets/koinonia-logo.jpg" alt="" width="26" height="26">
          <span><strong>Koinonia</strong></span>
        </a>
        <div class="spacer"></div>
        ${(state.me.teaches ?? []).length
          ? `<a class="btn btn-sm" href="../teacher/">Teaching</a>` : ""}
        ${state.me.is_admin
          ? `<a class="btn btn-sm" href="../admin/">Administration</a>` : ""}
        <button class="btn btn-sm btn-ghost" id="out">Sign out</button>
      </div>
    </nav>

    <div class="wrap page">
      <div class="page-head">
        <div>
          <h1>${esc(families[0]?.display_name ?? "Your family")}</h1>
          <div class="sub">Signed in as ${esc(state.me.email)}${
            state.me.is_admin
              ? ` · <span class="badge badge-ok">Administrator</span>` : ""}${
            (state.me.teaches ?? []).length
              ? ` · <span class="badge">Teaches ${
                  plural(state.me.teaches.length, "class", "classes")}</span>` : ""}</div>
        </div>
      </div>

      <nav class="subnav">
        ${PAGES.map(([href, label]) =>
          `<a href="#${href}" class="${href === path ? "active" : ""}">${esc(label)}</a>`
        ).join("")}
      </nav>

      ${families.length > 1 ? `<div class="note">
        Your address is on file for more than one family:
        ${families.map((f) => esc(f.display_name)).join(", ")}.
        Everything here covers all of them.</div>` : ""}

      ${body}
    </div>`);

  $("#out").addEventListener("click", async () => {
    await auth.signOut();
    location.reload();
  });
}

/**
 * Fetch, but never let one failing section blank the rest of the page.
 *
 * Deliberately not one try block around everything: sharing one meant a failure
 * in any single call skipped the rest, and the page then reported "no calendar"
 * when the real fault was somewhere else entirely.
 */
const settle = async (fn, fallback) => {
  try { return await fn(); } catch (e) { toastErr(e.message); return fallback; }
};

// -----------------------------------------------------------------------------
// This week
// -----------------------------------------------------------------------------
async function home() {
  const families = state.me.families ?? [];

  // Read straight through RLS rather than any privileged path. If the boundary
  // is wrong this is where it shows, in the plainest possible way.
  let children = [], semester = null, periods = [], absences = [], meetings = [];

  children = await settle(() => api.myChildren(families.map((f) => f.id)), []);
  semester = await settle(() => api.currentSemester(), null);

  if (semester) {
    [periods, absences, meetings] = await Promise.all([
      settle(() => api.periods(semester.id), []),
      settle(() => api.myAbsences({ from: todayISO() }), []),
      settle(() => api.meetings(semester.id), []),
    ]);
  }

  const active = children.filter((c) => c.active && !c.archived_at);

  // No roll-call of the family's own children here. It used to lead the page,
  // and it was the same names the week below already lists against their
  // classes — a parent does not need reminding who lives in their house, and on
  // a phone it pushed the thing they came for off the screen. The children are
  // still fetched: the absence form is built from them.
  shell("/", `
    ${active.length ? "" : `<div class="note">
      There are no children on your family record yet. An administrator can add
      them.</div>`}

    <div id="week"></div>

    <div id="absences"></div>`);

  Week.render_($("#week"), { meetings, onNeedsRefresh: () => home() });

  Absences.render_($("#absences"), {
    children: active, semester, periods, absences, meetings,
    onChange: () => home(),
  });
}

/** The week arrows moved; redraw that section and leave the rest alone. */
async function redrawWeek() {
  const el = $("#week");
  if (!el || !state.me?.recognised) return;
  try {
    const sem = await api.currentSemester();
    const meetings = sem ? await api.meetings(sem.id) : [];
    Week.render_(el, { meetings, onNeedsRefresh: () => home() });
  } catch { /* keep what the section already had rather than emptying it */ }
}

// -----------------------------------------------------------------------------
// Registration
//
// Read-only, because registering is currently something the registrar records
// rather than something a family does here. Worth a page of its own anyway: the
// commonest question a parent has in August is "are we actually signed up", and
// the commonest answer until now was to email somebody and wait.
// -----------------------------------------------------------------------------
async function registrationPage() {
  const rows = await settle(
    async () => (await api.proposalPayload())?.registration ?? [], []);

  shell("/registration", `
    <div class="card">
      <div class="card-head"><h3>Registration</h3></div>
      <p class="muted">Whether your family is taking part, semester by semester.
        This is not the same as signing your children up for classes, which
        happens separately.</p>

      ${rows.length ? `<div class="table-scroll mt"><table>
        <thead><tr><th>Semester</th><th>Your family</th></tr></thead>
        <tbody>${rows.map((r) => {
          const [label, cls] = REGISTRATION_STATUS[r.status] ?? ["Not started", ""];
          return `<tr>
            <td><strong>${esc(r.semester)}</strong></td>
            <td><span class="badge ${cls}">${esc(label)}</span></td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>`
      : `<p class="muted mt">No semesters have been set up yet.</p>`}

      <div class="note mt">
        The registrar keeps this up to date. If something here looks wrong, tell
        her — it cannot be changed from this page.
      </div>
    </div>

    <div id="regform"></div>`);

  // The form itself, when a window is open. It renders its own card — or a line
  // saying registration is not open — so the page reads the same either way.
  await RegForm.render_($("#regform"), { onChange: () => registrationPage() });
}

// -----------------------------------------------------------------------------
// Your family
//
// Editable, because the parents are the only people who know any of it. It used
// to be a read-only list on the front page, which told a mother what she
// already knew and gave her nowhere to correct it.
// -----------------------------------------------------------------------------
async function familyPage() {
  shell("/family", `<div id="famsetup"></div>`);
  await FamilySetup.render_($("#famsetup"));
}

// -----------------------------------------------------------------------------
// Propose a class
// -----------------------------------------------------------------------------
async function proposalsPage() {
  shell("/proposals", `<div id="proposals"></div>`);
  await Proposals.render_($("#proposals"), { onChange: () => {} });
}

/** Today, as YYYY-MM-DD in local time — not UTC, which can be yesterday here. */
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

window.addEventListener("hashchange", route);

start();
