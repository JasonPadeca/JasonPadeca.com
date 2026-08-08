// =============================================================================
// request-signin
//
// The front door decides, server-side, whether an address belongs to anyone in
// the co-op before a single email is sent.
//
// WHY THIS EXISTS
//
// A parent who mistypes their address is the common case — far commoner than
// anybody probing the membership list. If the page simply said "check your
// email" to everyone, that parent would sit waiting for mail that was never
// coming, conclude the site is broken, and email an administrator. Telling them
// plainly that the address is not recognised is worth more than hiding who
// belongs to a homeschool co-op.
//
// Doing the check HERE rather than in the browser matters for a second reason.
// The page cannot be trusted to gate anything: anyone can call the Supabase auth
// API directly. If sign-in creates users on demand, a script pointed at that
// endpoint makes the co-op's own Gmail account send mail to any address it
// likes — burning the daily sending limit that legitimate co-op mail depends on,
// and earning the account a spam reputation while it does. Only this function
// holds the service role, so only this function can trigger a send.
//
// WHAT COUNTS AS KNOWN
//
// The family's address, any parent's address, or an active administrator's.
// Parents matter: a father who only ever gave his own address should get in,
// and matching the household address alone would leave him stranded.
// =============================================================================

import { json, preflight, serviceClient } from "../_shared/deps.ts";

Deno.serve(async (req: Request): Promise<Response> => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== "POST") {
    return json(req, { ok: false, error: "method_not_allowed" }, 405);
  }

  let email = "";
  let wantedRedirect = "";
  try {
    const body = await req.json();
    email = String(body?.email ?? "").trim().toLowerCase();
    wantedRedirect = String(body?.redirect_to ?? "").trim();
  } catch {
    return json(req, { ok: false, error: "bad_request" }, 400);
  }

  // Cheap shape check before touching the database.
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(req, { ok: false, error: "invalid_email" }, 400);
  }

  // --- Where should the link come back to? ----------------------------------
  //
  // Without this, Supabase falls back to the project's Site URL — which ships
  // as http://localhost:3000 and sent every family's magic link to a server on
  // their own machine that does not exist.
  //
  // The page asks to be returned to itself, but a client-supplied redirect is
  // never taken on trust: an open redirect on an authentication endpoint hands
  // an attacker a link that looks like ours and lands the session somewhere
  // else. It has to match an origin we already publish to.
  const redirectTo = safeRedirect(wantedRedirect);

  const db = serviceClient();

  // --- Is this anybody we know? ---------------------------------------------
  // Archived and inactive families are deliberately excluded: someone who has
  // left the co-op should not keep a way in. Administrators are checked
  // separately, since an admin need not be a parent.
  const [famRes, parentRes, adminRes, teacherRes, applicantRes] = await Promise.all([
    db.from("families")
      .select("id")
      .ilike("primary_email", email)
      .eq("active", true)
      .is("archived_at", null)
      .limit(1),
    db.from("parents")
      .select("id, families!inner(active, archived_at)")
      .ilike("email", email)
      .eq("families.active", true)
      .is("families.archived_at", null)
      .limit(1),
    db.from("admins")
      .select("id")
      .ilike("email", email)
      .eq("active", true)
      .limit(1),
    // A teacher need not be a parent — the grandfather taking the automotive
    // class has no family record to be found in.
    db.from("teachers")
      .select("id")
      .ilike("email", email)
      .eq("active", true)
      .limit(1),
    // Somebody who has applied to join. Applying IS the request for a login:
    // they sign in to follow the application rather than waiting on email.
    db.rpc("is_open_applicant", { p_email: email }),
  ]);

  const known =
    (famRes.data?.length ?? 0) > 0 ||
    (parentRes.data?.length ?? 0) > 0 ||
    (adminRes.data?.length ?? 0) > 0 ||
    (teacherRes.data?.length ?? 0) > 0 ||
    applicantRes.data === true;

  if (!known) {
    // 200, not 404. This is a normal answer to a reasonable question, and the
    // page needs to tell the parent something useful rather than render an
    // error state.
    return json(req, { ok: false, error: "not_recognised" });
  }

  // --- Make sure an auth user exists ----------------------------------------
  //
  // A family signing in for the first time has none. Creating it here, rather
  // than letting the sign-in call create users on demand, is the whole point:
  // creation happens only for an address we have just verified belongs to
  // somebody. email_confirm is set because we are about to prove control of the
  // mailbox anyway — the sign-in email IS the confirmation.
  const { error: createErr } = await db.auth.admin.createUser({
    email,
    email_confirm: true,
  });

  // "already registered" is the expected case for everyone after their first
  // time, and is not a failure.
  if (createErr && !/already|exists|registered/i.test(createErr.message)) {
    console.error("createUser failed", createErr.message);
    return json(req, { ok: false, error: "signin_failed" }, 500);
  }

  // --- Send the sign-in email ------------------------------------------------
  //
  // Handed to Supabase Auth rather than sent from here, so the message stays
  // the one configured in the dashboard — link and code together, from the
  // co-op's own SMTP. create_user is false now: the user exists by this point,
  // and leaving it true would quietly restore the hole this function closes.
  const otpUrl = new URL(`${Deno.env.get("SUPABASE_URL")}/auth/v1/otp`);
  otpUrl.searchParams.set("redirect_to", redirectTo);

  const res = await fetch(otpUrl, {
    method: "POST",
    headers: {
      "apikey": Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      create_user: false,
      // GoTrue reads this from the query string on /otp, not the body — so it
      // goes in both. Passing it in the body alone silently does nothing, which
      // is precisely how the localhost bug survived a green test.
      redirect_to: redirectTo,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    console.error("otp send failed", res.status, detail);
    // Supabase's own per-hour cap is worth naming, because the remedy is
    // "wait", not "try a different address".
    if (res.status === 429) {
      return json(req, { ok: false, error: "rate_limited" }, 429);
    }
    return json(req, { ok: false, error: "signin_failed" }, 500);
  }

  return json(req, { ok: true });
});

/**
 * Only ever return a URL on an origin we publish to.
 *
 * ALLOWED_ORIGINS is the same secret the CORS layer uses, so there is one list
 * to keep right rather than two that can drift. Anything else — a different
 * host, a javascript: scheme, a typo — falls back to the portal on the first
 * allowed origin, which is always somewhere safe to land.
 */
function safeRedirect(wanted: string): string {
  const allowed = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  const fallback = allowed.length
    ? `${allowed[0].replace(/\/+$/, "")}/coop/portal/`
    : `${Deno.env.get("SUPABASE_URL")}`;

  if (!wanted) return fallback;

  let url: URL;
  try {
    url = new URL(wanted);
  } catch {
    return fallback;
  }

  if (url.protocol !== "https:" && url.hostname !== "localhost") return fallback;
  if (!allowed.includes(url.origin)) return fallback;

  // Strip any query or fragment the caller attached; the destination is a page,
  // and Supabase appends its own parameters on the way back.
  return `${url.origin}${url.pathname}`;
}
