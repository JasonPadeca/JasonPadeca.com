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
import { esc, $, render, toastErr, ageAt } from "../assets/ui.js";

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

  // --- A tapped sign-in link -------------------------------------------------
  //
  // The link carries ?token_hash=…, which this page redeems itself, rather than
  // relying on Supabase's own /verify redirect. Two reasons, both learned the
  // hard way:
  //
  //   * That redirect returns the session in the URL *fragment*, and a fragment
  //     does not reliably survive a redirect chain through an in-app browser.
  //     The page loaded, the tokens did not, and the parent was looking at a
  //     sign-in form having just tapped "Sign in".
  //   * This client uses PKCE for Google sign-in, and a server-generated magic
  //     link has no code verifier to pair with. Redeeming the token hash
  //     directly sidesteps the mismatch entirely.
  //
  // A query parameter survives everything a fragment does not.
  const params = new URLSearchParams(location.search);
  const tokenHash = params.get("token_hash");

  if (tokenHash) {
    try {
      await auth.verifyTokenHash(tokenHash, params.get("type") || "email");
    } catch (e) {
      history.replaceState({}, "", location.pathname);
      return signedOut(e.message);
    }
  }

  try {
    state.session = await auth.session();
  } catch (e) {
    return signedOut(e.message);
  }

  // Clear the used token out of the address bar either way — reloading with a
  // spent one would look like a failure rather than a completed sign-in.
  if (location.search) history.replaceState({}, "", location.pathname);

  if (!state.session) return signedOut();

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
// Signed out — step 2: the email is sent
//
// The CODE leads here, not the link, and that ordering is deliberate.
//
// Tapping a link inside the Gmail or Mail app opens it in that app's own
// built-in browser. Even when it works perfectly, the parent is now signed in
// *there* — and the next time they open Chrome or Safari they are signed out
// again, with no idea why. Typing the code puts the session in the browser they
// actually use.
//
// The link still works, and is still in the email, for anyone reading mail on a
// computer where it does the obvious thing.
// -----------------------------------------------------------------------------
function awaitingCode(email) {
  render(app, `<div class="signin-page">
    <div class="signin-card">
      <img src="../assets/koinonia-logo.jpg" alt="" class="signin-mark" width="72" height="72">
      <h1>Check your email</h1>
      <p class="signin-sub">We have sent a code to <strong>${esc(email)}</strong>.
        Type it in below.</p>

      <form id="codeform" novalidate>
        <div class="field">
          <label for="code">Code from the email</label>
          <input type="text" id="code" name="code" inputmode="numeric" pattern="[0-9]*"
                 autocomplete="one-time-code" maxlength="10" class="code-input"
                 aria-describedby="codehelp">
          <div class="hint" id="codehelp">Keep this page open and switch to your
            email to fetch it.</div>
        </div>
        <button class="btn btn-primary btn-block" type="submit" id="verify">Sign in</button>
      </form>

      <div class="or-rule"><span>or</span></div>

      <p class="signin-sub" style="margin-bottom:0">
        Tap <strong>Sign in</strong> in the email. On a phone that often opens
        inside the mail app's own browser, which signs you in there rather than
        in Chrome or Safari — so the code above is usually the better bet.
      </p>

      <p class="signin-foot">
        Nothing arrived? Check your spam folder, or
        <a href="#" id="again">use a different address</a>.
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
