// =============================================================================
// Family portal — sign-in.
//
// One front door for everybody. A parent signs in and sees their family; an
// administrator who is also a parent sees the same thing plus a way through to
// the administration side. Authorization is a table lookup, not a separate
// login, which is why "gate it to some but not others" needs no new machinery.
//
// Sign-in is a magic link with a six-digit code beside it in the same email.
// Two reasons for the code rather than the link alone:
//
//   * Tapping a link in iOS Mail opens an in-app browser. The session lands
//     there rather than in Safari, so the parent returns later, finds
//     themselves signed out, and concludes the site is broken.
//   * PKCE keeps the code verifier in the browser that started the sign-in, so
//     a link opened on a different device cannot complete. The six digits can
//     be carried across a room; a link cannot.
//
// After the first sign-in the session persists and renews itself, so this page
// is a door, not a turnstile — see persistSession in api.js.
// =============================================================================

import { auth, api, IS_CONFIGURED } from "../assets/api.js";
import { esc, $, render, toastOk, toastErr, plural, ageAt } from "../assets/ui.js";

const app = document.getElementById("app");

// Remembered only between the two steps of one sign-in, so a reload during
// "check your email" does not lose which address was used.
const PENDING_EMAIL = "coop.portal.pending-email";

let state = { session: null, me: null };

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------
async function start() {
  if (!IS_CONFIGURED) {
    return render(app, `<div class="wrap page"><div class="note note-danger">
      This site is not configured yet. See coop/SETUP.md.</div></div>`);
  }

  try {
    // A magic link arrives as ?code=… and supabase-js exchanges it during
    // client construction, so simply asking for the session resolves it.
    state.session = await auth.session();
  } catch (e) {
    return signedOut(e.message);
  }

  if (!state.session) return signedOut();

  // Clean the auth code out of the address bar so a reload does not try to
  // redeem a consumed one.
  if (location.search.includes("code=") || location.search.includes("error=")) {
    history.replaceState({}, "", location.pathname);
  }

  try {
    state.me = await auth.establishSession();
  } catch (e) {
    return signedOut(e.message);
  }

  localStorage.removeItem(PENDING_EMAIL);

  if (!state.me?.recognised) return notRecognised();
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
          Email me a sign-in link
        </button>
      </form>

      <p class="signin-foot">No password required. You will stay signed in on this
        device, so you should only have to do this once.</p>
    </div>
  </div>`);

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
      toastErr(err.message);
      btn.disabled = false;
      btn.textContent = "Email me a sign-in link";
    }
  });
}

// -----------------------------------------------------------------------------
// Signed out — step 2: the link is sent, offer the code as well
// -----------------------------------------------------------------------------
function awaitingCode(email) {
  render(app, `<div class="signin-page">
    <div class="signin-card">
      <img src="../assets/koinonia-logo.jpg" alt="" class="signin-mark" width="72" height="72">
      <h1>Check your email</h1>
      <p class="signin-sub">We have sent a sign-in link to <strong>${esc(email)}</strong>.
        Open it on this device and you are in.</p>

      <div class="or-rule"><span>or enter the code from that email</span></div>

      <form id="codeform" novalidate>
        <div class="field">
          <label for="code">Six-digit code</label>
          <input type="text" id="code" name="code" inputmode="numeric" pattern="[0-9]*"
                 autocomplete="one-time-code" maxlength="6" class="code-input"
                 placeholder="000000" aria-describedby="codehelp">
          <div class="hint" id="codehelp">Use this if the link opens somewhere
            unexpected — on an iPhone, mail often opens links in its own browser.</div>
        </div>
        <button class="btn btn-primary btn-block" type="submit" id="verify">Sign in</button>
      </form>

      <p class="signin-foot">
        Nothing arrived? Check your spam folder, or
        <a href="#" id="again">use a different address</a>.
      </p>
    </div>
  </div>`);

  const input = $("#code");
  input.focus();

  // Six digits is the whole form; making them press a button as well is a step
  // for the sake of it.
  input.addEventListener("input", () => {
    input.value = input.value.replace(/\D/g, "").slice(0, 6);
    if (input.value.length === 6) $("#codeform").requestSubmit();
  });

  $("#codeform").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = input.value.trim();
    if (code.length !== 6) return toastErr("The code is six digits.");

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

  $("#again").addEventListener("click", (e) => {
    e.preventDefault();
    localStorage.removeItem(PENDING_EMAIL);
    signedOut();
  });
}

// -----------------------------------------------------------------------------
// Signed in, but nobody we know
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
// -----------------------------------------------------------------------------
async function home() {
  const families = state.me.families ?? [];

  // Read straight through RLS rather than any privileged path. If the boundary
  // is wrong this is where it shows, in the plainest possible way.
  let children = [];
  let semester = null;
  try {
    children = await api.myChildren(families.map((f) => f.id));
    semester = await api.currentSemester();
  } catch (e) {
    toastErr(e.message);
  }

  const refDate = semester?.class_start_date;
  const active = children.filter((c) => c.active && !c.archived_at);

  render(app, `
    <nav class="topbar">
      <div class="wrap">
        <a class="brand" href="./">
          <img src="../assets/koinonia-logo.jpg" alt="" width="26" height="26">
          <span><strong>Koinonia</strong></span>
        </a>
        <div class="spacer"></div>
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
              ? ` · <span class="badge badge-ok">Administrator</span>` : ""}</div>
        </div>
      </div>

      ${families.length > 1 ? `<div class="note">
        Your address is on file for more than one family:
        ${families.map((f) => esc(f.display_name)).join(", ")}.
        Everything below covers all of them.</div>` : ""}

      <div class="card">
        <div class="card-head"><h3>Your children</h3></div>
        ${active.length ? `<div class="table-scroll"><table>
          <thead><tr><th>Name</th><th class="num">Age${
            refDate ? ` at ${esc(semester.name)}` : ""}</th></tr></thead>
          <tbody>${active.map((c) => `<tr>
            <td><strong>${esc(c.first_name)} ${esc(c.last_name ?? "")}</strong></td>
            <td class="num mono">${ageAt(c.birth_date, refDate) ?? `<span class="faint">—</span>`}</td>
          </tr>`).join("")}</tbody></table></div>`
          : `<p class="muted">No children on your family record yet. An administrator
             can add them.</p>`}
      </div>

      <div class="card">
        <div class="card-head"><h3>Coming soon</h3></div>
        <p class="muted">The calendar, handouts, absences, and class proposals will
          appear here. Registration still happens through the link emailed to you
          when a semester opens.</p>
      </div>
    </div>`);

  $("#out").addEventListener("click", async () => {
    await auth.signOut();
    location.reload();
  });
}

start();
