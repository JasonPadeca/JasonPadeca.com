// =============================================================================
// Administration application — boot, sign-in gate, and router (§7, §27).
//
// Hash routing, because GitHub Pages serves static files and has no rewrite
// rules: /admin/#/families/<id> is one real file with a fragment, whereas
// /admin/families/<id> would be a 404.
// =============================================================================

import { auth, api, IS_CONFIGURED } from "../assets/api.js";
import { esc, $, render, toast, toastErr, loading } from "../assets/ui.js";

import * as Dashboard  from "./views/dashboard.js";
import * as Families   from "./views/families.js";
import * as Semesters  from "./views/semesters.js";
import * as Enrollment from "./views/enrollment.js";
import * as Volunteers from "./views/volunteers.js";
import * as PrintRoster from "./views/print-roster.js";
import * as Exports    from "./views/exports.js";
import * as Settings   from "./views/settings.js";

const app = $("#app");

/** The signed-in admin row. Views read this for role checks. */
export let ADMIN = null;

// -----------------------------------------------------------------------------
// Routes. Each pattern is matched in order; :params are captured.
// -----------------------------------------------------------------------------
const ROUTES = [
  ["#/",                       Dashboard.show],
  ["#/families",               Families.list],
  ["#/families/:id",           Families.detail],
  ["#/semesters",              Semesters.list],
  ["#/semesters/:id",          Semesters.detail],
  ["#/periods/:id",            Semesters.periodDetail],
  ["#/classes/:id",            Semesters.classDetail],
  ["#/classes/:id/print",      PrintRoster.show],
  ["#/semesters/:id/rosters",  PrintRoster.all],
  ["#/enrollment",             Enrollment.show],
  ["#/volunteers",             Volunteers.show],
  ["#/exports",                Exports.show],
  ["#/settings",               Settings.show],
  ["#/audit",                  Settings.audit],
];

const NAV = [
  ["#/",           "Dashboard"],
  ["#/families",   "Families"],
  ["#/semesters",  "Semesters"],
  ["#/enrollment", "Enrollment"],
  ["#/volunteers", "Volunteers"],
  ["#/exports",    "Exports"],
  ["#/settings",   "Settings"],
];

// =============================================================================
// Boot
// =============================================================================
(async function boot() {
  if (!IS_CONFIGURED) {
    return render(app, `<div class="centered">
      <h1>Not configured</h1>
      <p class="muted mt">This site has not been connected to a Supabase project yet.
      Fill in <code>coop/assets/config.js</code> — see <code>coop/SETUP.md</code>.</p>
    </div>`);
  }

  try {
    ADMIN = await auth.currentAdmin();
  } catch (e) {
    return renderSignIn(e.message);
  }

  if (!ADMIN) {
    const session = await auth.session();
    // Two very different situations that look the same from here: nobody has
    // signed in yet, or someone signed in whom nobody has authorised (§27).
    return renderSignIn(null, !!session);
  }

  $("#topbar").hidden = false;
  $("#signout").addEventListener("click", async () => {
    await auth.signOut();
    location.reload();
  });

  window.addEventListener("hashchange", route);
  await route();
})();

function renderSignIn(error, authenticatedButUnauthorised = false) {
  $("#topbar").hidden = true;

  if (authenticatedButUnauthorised) {
    render(app, `<div class="centered">
      <h1>No access</h1>
      <p class="muted mt">You do not have access to this administration system.</p>
      <p class="faint tiny mt">If you believe this is a mistake, ask the co-op's
      site owner to add this address as an administrator.</p>
      <div class="btn-row mt2" style="justify-content:center">
        <!-- Most people who land here are parents who followed a link or typed
             the address. Signing them out is the wrong first offer; they are
             signed in perfectly well, just not as an administrator. -->
        <a class="btn btn-primary" href="../portal/">Go to the family portal</a>
        <button class="btn" id="out">Sign out</button>
      </div>
    </div>`);
    $("#out").addEventListener("click", async () => {
      await auth.signOut();
      location.reload();
    });
    return;
  }

  render(app, `<div class="centered">
    <h1>Co-op Administration</h1>
    <p class="muted mt">Sign in with the Google account your co-op has authorised.</p>
    ${error ? `<div class="note note-danger mt2">${esc(error)}</div>` : ""}
    <div class="btn-row mt2" style="justify-content:center">
      <button class="btn btn-primary" id="signin">Continue with Google</button>
    </div>
  </div>`);

  $("#signin").addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      await auth.signInWithGoogle();
    } catch (err) {
      e.target.disabled = false;
      toastErr(err.message);
    }
  });
}

// =============================================================================
// Router
// =============================================================================

function match(hash) {
  for (const [pattern, handler] of ROUTES) {
    const p = pattern.split("/");
    const h = hash.split("/");
    if (p.length !== h.length) continue;

    const params = {};
    let ok = true;
    for (let i = 0; i < p.length; i++) {
      if (p[i].startsWith(":")) params[p[i].slice(1)] = decodeURIComponent(h[i]);
      else if (p[i] !== h[i]) { ok = false; break; }
    }
    if (ok) return { handler, params };
  }
  return null;
}

async function route() {
  const hash = location.hash || "#/";
  const found = match(hash);

  renderNav(hash);
  loading(app);

  if (!found) {
    return render(app, `<div class="wrap page"><div class="empty">
      <h3>Page not found</h3><p><a href="#/">Back to the dashboard</a></p>
    </div></div>`);
  }

  try {
    await found.handler(app, found.params);
  } catch (e) {
    console.error(e);
    render(app, `<div class="wrap page">
      <div class="note note-danger"><strong>Could not load this page.</strong>
      <div class="mt tiny">${esc(e.message)}</div></div>
      <div class="btn-row mt"><button class="btn" onclick="location.reload()">Try again</button></div>
    </div>`);
  }
}

// Period and class pages are reached by drilling into a semester, so they should
// keep Semesters lit rather than leaving the nav with nothing highlighted.
const NAV_ALIASES = { "#/periods": "#/semesters", "#/classes": "#/semesters", "#/audit": "#/settings" };

function renderNav(hash) {
  let top = "#/" + (hash.split("/")[1] ?? "");
  top = NAV_ALIASES[top] ?? top;
  render("#nav", NAV.map(([href, label]) =>
    `<a href="${href}" class="${href === top ? "active" : ""}">${esc(label)}</a>`
  ).join(""));
}

/** Views call this after a mutation that changes what the current page shows. */
export function refresh() {
  return route();
}

export function go(hash) {
  location.hash = hash;
}
