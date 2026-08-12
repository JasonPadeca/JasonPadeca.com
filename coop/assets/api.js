// =============================================================================
// Everything that talks to Supabase.
//
// Two distinct paths, and they never mix:
//
//   Admin  — signs in with Google, then reads and writes tables directly.
//            Row Level Security is what makes that safe; see 0002_authorization.
//   Family — has no Supabase session at all. Only the Edge Functions in
//            familyApi below, authenticated by an invitation token.
// =============================================================================

import { SUPABASE_URL, SUPABASE_ANON_KEY, FUNCTIONS_URL, IS_CONFIGURED } from "./config.js";

export { IS_CONFIGURED };

// =============================================================================
// Stale-module protection.
//
// There is no build step here, so every file is fetched by its own plain URL
// and GitHub Pages serves them with `cache-control: max-age=600`. That means a
// browser can perfectly well end up holding a NEW page script and a TEN MINUTE
// OLD copy of this file — new code calling a function that its cached api.js
// has never heard of. What the user sees is "api.something is not a function",
// which tells them nothing and looks like the update failed.
//
// A developer would hard-refresh. The people using this are a registrar and a
// handful of homeschool mothers on phones, who will not think of that and
// should not have to. So each app declares what it needs, and if the cached
// copy cannot provide it, we reload once — bypassing the cache — and carry on.
//
// Guarded by sessionStorage so a genuine missing function fails loudly instead
// of reloading forever.
// =============================================================================
export function needsFresh(names) {
  // sessionStorage throws in some private-browsing modes, and this runs before
  // anything else in the app. A guard that crashes the page it is meant to
  // rescue would be worse than no guard: fall back to doing nothing.
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* nothing */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch { /* nothing */ } },
  };

  const missing = names.filter((n) => typeof api[n] !== "function");
  if (!missing.length) {
    store.del("coop_reloaded_for");
    return false;
  }

  const already = store.get("coop_reloaded_for");
  const key = missing.join(",");
  if (already === key) {
    // Reloading did not help, so this is not a stale cache. Say so plainly
    // rather than looping.
    console.error("Missing after reload:", missing);
    document.body.innerHTML =
      '<div class="centered"><h1>This page needs updating</h1>' +
      '<p class="muted mt">Part of the site did not load correctly. ' +
      "Please close this tab and open it again. If it keeps happening, " +
      "tell Ben — nothing you have saved is affected.</p></div>";
    return true;
  }

  store.set("coop_reloaded_for", key);
  location.reload();
  return true;
}

let _client = null;

/** Lazily load supabase-js. Only the admin app needs it. */
export async function client() {
  if (_client) return _client;
  const { createClient } = await import(
    "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm"
  );
  _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      // PKCE returns the auth code as ?code=… in the query string. The implicit
      // flow would put #access_token=… in the fragment, which is exactly where
      // this app keeps its route — the two would fight over the hash.
      flowType: "pkce",
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true,
    },
  });
  return _client;
}

/** Postgres errors are precise but not friendly. Translate the ones users hit. */
export function friendlyError(error) {
  if (!error) return "Something went wrong.";
  const msg = error.message ?? String(error);

  if (msg.includes("registrations_one_confirmed_per_period"))
    return "That student already has a class in this period.";
  if (msg.includes("registrations_no_duplicate_live"))
    return "That student is already in this class.";
  if (msg.includes("periods_number_per_semester"))
    return "A period with that number already exists in this semester.";
  if (msg.includes("age_range_ordered"))
    return "The minimum age must be less than or equal to the maximum age.";
  if (msg.includes("semester_dates_ordered"))
    return "The last class date must fall on or after the first class date.";
  if (msg.includes("registration_dates_ordered"))
    return "Class sign-up must close after it opens.";
  if (msg.includes("period_times_ordered"))
    return "The end time must be after the start time.";
  if (msg.includes("capacity_check") || msg.includes("capacity >= 0"))
    return "Capacity cannot be negative.";
  if (msg.includes("Not authorized") || error.code === "42501")
    return "You do not have permission to do that.";
  if (msg.includes("Failed to fetch"))
    return "Could not reach the server. Check your connection and try again.";

  return msg;
}

/**
 * Code-verification errors, in words a parent can act on.
 *
 * Supabase's own messages are written for developers. "Token has expired or is
 * invalid" is accurate and tells a mother of four nothing about what to do
 * next — which is to send herself a fresh one.
 *
 * Only verifyOtp reaches this now; the send path is gated by the request-signin
 * Edge Function and reports its own errors.
 */
function friendlySignInError(error) {
  const msg = (error?.message ?? String(error)).toLowerCase();

  if (msg.includes("token has expired") || msg.includes("expired")) {
    return "That code has expired. Send yourself a new one and use it within the hour.";
  }
  if (msg.includes("invalid") && msg.includes("token")) {
    return "That code was not right. Check it against the email, or send yourself a new one.";
  }
  if (msg.includes("rate limit") || msg.includes("too many") || msg.includes("429")) {
    return "That is a lot of emails in a short time. Wait a minute and try again.";
  }
  if (msg.includes("failed to fetch")) {
    return "Could not reach the server. Check your connection and try again.";
  }
  return error?.message ?? "Something went wrong signing in.";
}

/** Throw on error, return data. Keeps call sites free of error plumbing. */
function unwrap({ data, error }) {
  if (error) throw new Error(friendlyError(error));
  return data;
}

// =============================================================================
// Authentication (§27)
// =============================================================================
export const auth = {
  async signInWithGoogle() {
    const db = await client();
    const { error } = await db.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin + window.location.pathname,
        queryParams: { prompt: "select_account" },
      },
    });
    if (error) throw new Error(friendlyError(error));
  },

  /**
   * Ask for a sign-in email, via the request-signin Edge Function.
   *
   * Deliberately NOT supabase.auth.signInWithOtp. That call creates a user for
   * whatever address it is handed, which means anyone can make the co-op's Gmail
   * send mail to an address of their choosing — and a mistyped address would get
   * a cheerful "check your email" for a message that was never sent. The
   * function checks the address against family, parent and admin records first,
   * so an unrecognised one comes back as exactly that.
   *
   * The email carries a code and no link. Tapping a link in a phone's mail app
   * opens it in that app's own browser, which signs the parent in there rather
   * than in Chrome or Safari — so they are signed out again the moment they go
   * back to their real browser.
   */
  async sendSignInEmail(email) {
    const res = await fetch(`${FUNCTIONS_URL}/request-signin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        email: email.trim().toLowerCase(),
        // Unused while the email is code-only, and kept anyway: if a link is
        // ever put back in the template, this is what stops it pointing at
        // localhost, which is where Supabase's default Site URL sends it. The
        // function validates it against its allowed origins — an unchecked
        // redirect on an auth endpoint is an open redirect.
        redirect_to: window.location.origin + window.location.pathname,
      }),
    }).catch(() => null);

    if (!res) {
      throw new Error("Could not reach the server. Check your connection and try again.");
    }

    let body = {};
    try { body = await res.json(); } catch { /* fall through to the status */ }

    if (body.ok) return;

    switch (body.error) {
      case "not_recognised":
        throw new Error(
          "That email address is not on file for any family in the co-op. " +
          "Check the spelling, or try the other address your family uses. " +
          "If it still does not work, ask an administrator to check what is on your record.");
      case "invalid_email":
        throw new Error("That does not look like an email address.");
      case "rate_limited":
        throw new Error("Too many sign-in emails have gone out in the last hour. Please wait a little and try again.");
      default:
        throw new Error("Something went wrong sending your sign-in email. Please try again.");
    }
  },

  /** Finish sign-in with the code from the email. */
  async verifyCode(email, code) {
    const db = await client();
    const { data, error } = await db.auth.verifyOtp({
      email: email.trim().toLowerCase(),
      token: code.trim(),
      type: "email",
    });
    if (error) throw new Error(friendlySignInError(error));
    return data.session;
  },

  /**
   * Who is this, and what are they entitled to? One call, made once after
   * sign-in: it links the verified address to a family and binds an admin
   * identity if there is one.
   */
  async establishSession() {
    const db = await client();
    const { data, error } = await db.rpc("establish_session");
    if (error) throw new Error(friendlyError(error));
    return data;
  },

  async signOut() {
    const db = await client();
    await db.auth.signOut();
  },

  async session() {
    const db = await client();
    return (await db.auth.getSession()).data.session;
  },

  /**
   * The authorization half of §27: Google says who you are, this says whether
   * that person may use the admin interface. Returns the admin row or null.
   */
  async currentAdmin() {
    const db = await client();
    const session = (await db.auth.getSession()).data.session;
    if (!session) return null;
    const { data, error } = await db.rpc("bind_admin_identity");
    if (error) return null;
    // The RPC returns a row-shaped NULL for an authenticated non-admin.
    return data && data.id ? data : null;
  },

  async accessToken() {
    return (await this.session())?.access_token ?? null;
  },
};

// =============================================================================
// Admin data access.
//
// These are thin wrappers over PostgREST. RLS decides what comes back; if the
// caller is not an active admin, every one of these returns nothing rather than
// failing loudly, which is the correct behaviour for a table they cannot see.
// =============================================================================
export const api = {
  // --- Families ---
  async families({ includeArchived = false, search = "" } = {}) {
    const db = await client();
    let q = db.from("families")
      .select("*, parents(id, first_name, last_name, sort_order), children(id, first_name, last_name, birth_date, sex, active, archived_at)")
      .order("display_name");
    if (!includeArchived) q = q.is("archived_at", null);
    if (search) q = q.ilike("display_name", `%${search}%`);
    return unwrap(await q);
  },

  async family(id) {
    const db = await client();
    return unwrap(await db.from("families")
      .select("*, parents(*), children(*)")
      .eq("id", id).single());
  },

  async createFamily(fields)      { const db = await client(); return unwrap(await db.from("families").insert(fields).select().single()); },
  async updateFamily(id, fields)  { const db = await client(); return unwrap(await db.from("families").update(fields).eq("id", id).select().single()); },
  async archiveFamily(id, on)     { return this.updateFamily(id, { archived_at: on ? new Date().toISOString() : null, active: !on }); },

  async createParent(fields)      { const db = await client(); return unwrap(await db.from("parents").insert(fields).select().single()); },
  async updateParent(id, fields)  { const db = await client(); return unwrap(await db.from("parents").update(fields).eq("id", id).select().single()); },
  async deleteParent(id)          { const db = await client(); return unwrap(await db.from("parents").delete().eq("id", id)); },

  async createChild(fields)       { const db = await client(); return unwrap(await db.from("children").insert(fields).select().single()); },
  async updateChild(id, fields)   { const db = await client(); return unwrap(await db.from("children").update(fields).eq("id", id).select().single()); },
  async archiveChild(id, on)      { return this.updateChild(id, { archived_at: on ? new Date().toISOString() : null, active: !on }); },

  // --- Semesters, periods, classes ---
  async semesters({ includeArchived = false } = {}) {
    const db = await client();
    let q = db.from("semesters").select("*").order("class_start_date", { ascending: false, nullsFirst: false });
    if (!includeArchived) q = q.is("archived_at", null);
    return unwrap(await q);
  },

  async semester(id) {
    const db = await client();
    return unwrap(await db.from("semesters").select("*").eq("id", id).single());
  },

  async createSemester(f)         { const db = await client(); return unwrap(await db.from("semesters").insert(f).select().single()); },
  async updateSemester(id, f)     { const db = await client(); return unwrap(await db.from("semesters").update(f).eq("id", id).select().single()); },

  async periods(semesterId, { includeArchived = false } = {}) {
    const db = await client();
    let q = db.from("periods").select("*").eq("semester_id", semesterId)
      .order("sort_order").order("period_number");
    if (!includeArchived) q = q.is("archived_at", null);
    return unwrap(await q);
  },

  async period(id) {
    const db = await client();
    return unwrap(await db.from("periods").select("*, semesters(*)").eq("id", id).single());
  },

  async createPeriod(f)           { const db = await client(); return unwrap(await db.from("periods").insert(f).select().single()); },
  async updatePeriod(id, f)       { const db = await client(); return unwrap(await db.from("periods").update(f).eq("id", id).select().single()); },
  async archivePeriod(id, on)     { return this.updatePeriod(id, { archived_at: on ? new Date().toISOString() : null }); },

  /**
   * Classes with live seat counts attached as `c.seats`.
   *
   * The counts are fetched in a second request rather than embedded via
   * `select("*, class_seats(*)")`. PostgREST resolves embedded resources
   * through foreign keys, and class_seats is a view — a view cannot have one,
   * so the embed fails with "Could not find a relationship … in the schema
   * cache". Two round trips, and no dependence on relationship inference.
   */
  async classes(where = {}, { includeArchived = false } = {}) {
    const db = await client();
    let q = db.from("classes").select("*")
      .order("option_number", { nullsFirst: false }).order("name");
    for (const [k, v] of Object.entries(where)) q = q.eq(k, v);
    if (!includeArchived) q = q.is("archived_at", null);

    const rows = unwrap(await q);
    if (!rows.length) return rows;

    // Counts come from a gated function, not the class_seats view: the view is
    // security_invoker, so reading it directly would count only the rows the
    // caller can see. See the note in 0012_family_accounts.sql.
    const wanted = new Set(rows.map((c) => c.id));
    const seats = (unwrap(await db.rpc("class_seat_counts")) ?? [])
      .filter((s) => wanted.has(s.class_id));
    const byId = new Map(seats.map((s) => [s.class_id, s]));
    return rows.map((c) => ({ ...c, seats: byId.get(c.id) ?? {} }));
  },

  async klass(id) {
    const db = await client();
    // periods and semesters embed fine — those are real foreign keys.
    const row = unwrap(await db.from("classes")
      .select("*, periods(*), semesters(*)").eq("id", id).single());
    const seats = (unwrap(await db.rpc("class_seat_counts")) ?? [])
      .find((s) => s.class_id === id);
    return { ...row, seats: seats ?? {} };
  },

  async createClass(f)            { const db = await client(); return unwrap(await db.from("classes").insert(f).select().single()); },
  async updateClass(id, f)        { const db = await client(); return unwrap(await db.from("classes").update(f).eq("id", id).select().single()); },
  async archiveClass(id, on)      { return this.updateClass(id, { archived_at: on ? new Date().toISOString() : null }); },

  // --- Registrations ---
  /**
   * A class roster with everything a printed sheet needs: age, contact details,
   * allergies, and medical notes.
   *
   * parents(...) comes along so a family with no primary_phone set still shows
   * a number — the first parent who has one.
   */
  async classRoster(classId) {
    const db = await client();
    return unwrap(await db.from("registrations")
      .select(`*, children(
                 id, first_name, last_name, birth_date, sex, email, phone,
                 allergies, medical_notes, family_id,
                 families(id, display_name, primary_email, primary_phone,
                          parents(first_name, last_name, phone, email, sort_order)))`)
      .eq("class_id", classId)
      .order("status").order("waitlisted_at", { nullsFirst: true }).order("created_at"));
  },

  /**
   * Mark a child as taking classes this semester, or not.
   *
   * Deliberately the same row a parent writes from the registration page, with
   * no precedence between them — whoever touched it last is who is right. An
   * administrator marking a child out is usually acting on something the family
   * told them; a family changing their mind afterwards is the family knowing
   * better. Locking either side out would only produce phone calls.
   */
  async setParticipation(childId, semesterId, participating) {
    const db = await client();
    return unwrap(await db.from("semester_participation")
      .upsert({
        child_id: childId,
        semester_id: semesterId,
        participating,
        set_by: "admin",
      }, { onConflict: "child_id,semester_id" })
      .select().single());
  },

  /** Child ids sitting this semester out, as a Set. */
  async sittingOut(semesterId) {
    const db = await client();
    const rows = unwrap(await db.from("semester_participation")
      .select("child_id, participating")
      .eq("semester_id", semesterId)
      .eq("participating", false));
    return new Set(rows.map((r) => r.child_id));
  },

  async semesterRegistrations(semesterId) {
    const db = await client();
    return unwrap(await db.from("registrations")
      .select("*, children(id, first_name, last_name, birth_date, sex, families(id, display_name, primary_email)), classes(id, name, period_id, periods(period_number, display_name))")
      .eq("semester_id", semesterId)
      .in("status", ["registered", "waitlisted"]));
  },

  async checkPlacement(childId, classId, status = "registered") {
    const db = await client();
    return unwrap(await db.rpc("check_placement",
      { p_child_id: childId, p_class_id: classId, p_status: status }));
  },

  async placeChild(childId, classId, status = "registered", override = false, reason = null) {
    const db = await client();
    return unwrap(await db.rpc("admin_place_child", {
      p_child_id: childId, p_class_id: classId, p_status: status,
      p_override: override, p_override_reason: reason,
    }));
  },

  async setRegistrationStatus(id, status) {
    const db = await client();
    return unwrap(await db.rpc("admin_set_registration_status",
      { p_registration_id: id, p_status: status }));
  },

  async promoteWaitlist(id, override = false) {
    const db = await client();
    return unwrap(await db.rpc("promote_waitlist_entry",
      { p_registration_id: id, p_override: override }));
  },

  // --- Summaries ---
  async summary(semesterId) {
    const db = await client();
    return unwrap(await db.rpc("semester_summary", { p_semester_id: semesterId }));
  },

  async preflight(semesterId) {
    const db = await client();
    return unwrap(await db.rpc("registration_preflight", { p_semester_id: semesterId }));
  },

  // --- Family portal ---
  //
  // These deliberately use the ordinary table endpoints rather than any
  // privileged path. What comes back is whatever RLS allows, so if the boundary
  // in 0012 is wrong, it is wrong here in plain sight.

  /**
   * The signed-in parent's own children.
   *
   * familyIds is passed explicitly rather than leaning on RLS to narrow it. RLS
   * decides what you MAY see; the query should still say what it MEANS. Without
   * it, an administrator who is also a parent gets the admin policy on top and
   * this returns every child in the co-op — which is authorised, and also not
   * even slightly what "your children" means.
   */
  async myChildren(familyIds = []) {
    const db = await client();
    if (!familyIds.length) return [];
    return unwrap(await db.from("children")
      .select("id, first_name, last_name, birth_date, sex, active, archived_at, family_id")
      .in("family_id", familyIds)
      .order("birth_date", { nullsFirst: false }));
  },

  /** The semester a family should currently be looking at, if any. */
  async currentSemester() {
    const db = await client();
    const rows = unwrap(await db.from("semesters")
      .select("*")
      .is("archived_at", null)
      .in("status", ["registration_open", "registration_closed", "active"])
      .order("class_start_date", { ascending: false, nullsFirst: false })
      .limit(1));
    return rows?.[0] ?? null;
  },

  // --- Absences ---

  /**
   * Upcoming absences for whoever is signed in. RLS scopes it.
   *
   * The date lives on the meeting now, not the absence — filtering and ordering
   * go through the embedded meeting_dates row. `!inner` makes the embed a real
   * join so the filter applies to the outer rows rather than just emptying the
   * embedded object.
   */
  async myAbsences({ from = null } = {}) {
    const db = await client();
    const rows = unwrap(await db.from("absences")
      .select(`*, absence_periods(period_id),
               children(id, first_name, last_name),
               meeting_dates(id, meets_on, cancelled, cancel_reason, note)`));

    // Filtered and sorted here rather than in the query. PostgREST can filter on
    // an embedded table, but a family has a handful of absences at most, and
    // doing it in JavaScript is one less thing whose behaviour differs between
    // the real server and anything standing in for it.
    return rows
      .filter((a) => !from || (a.meeting_dates?.meets_on ?? "") >= from)
      .sort((a, b) => (a.meeting_dates?.meets_on ?? "").localeCompare(b.meeting_dates?.meets_on ?? ""));
  },

  async generateMeetings(semesterId) {
    const db = await client();
    return unwrap(await db.rpc("generate_meeting_dates", { p_semester_id: semesterId }));
  },

  async updateMeeting(id, fields) {
    const db = await client();
    return unwrap(await db.from("meeting_dates").update(fields).eq("id", id).select().single());
  },

  async addMeeting(semesterId, meetsOn) {
    const db = await client();
    return unwrap(await db.from("meeting_dates")
      .insert({ semester_id: semesterId, meets_on: meetsOn }).select().single());
  },

  async deleteMeeting(id) {
    const db = await client();
    return unwrap(await db.from("meeting_dates").delete().eq("id", id));
  },

  // --- Teaching ---

  /** One class as its teacher may see it. A different shape from the admin view. */
  async teacherClass(classId, meetingId = null) {
    const db = await client();
    return unwrap(await db.rpc("teacher_class_view", {
      p_class_id: classId, p_meeting_id: meetingId,
    }));
  },

  /**
   * Who is away on one meeting, among students the caller may see.
   *
   * RLS does the scoping — a teacher gets their own students, a parent gets
   * their own children — so this needs no audience argument and cannot be
   * pointed at somebody else's class by changing a parameter.
   */
  async absencesForMeeting(meetingId) {
    const db = await client();
    const rows = unwrap(await db.from("absences")
      .select(`id, whole_day, reason,
               children(id, first_name, last_name),
               absence_periods(period_id)`)
      .eq("meeting_id", meetingId));

    const periods = unwrap(await db.from("periods").select("id, period_number"));
    const byId = new Map(periods.map((p) => [p.id, p.period_number]));

    return rows.map((a) => ({
      id: a.id,
      child_name: `${a.children?.first_name ?? ""} ${a.children?.last_name ?? ""}`.trim(),
      reason: a.reason,
      whole_day: a.whole_day,
      // Empty means the whole day, which is every period.
      periods: (a.absence_periods ?? []).map((ap) => byId.get(ap.period_id)).filter(Boolean),
    }));
  },

  /** A parent's view of one class day: their children, and anything posted. */
  async familyWeek(meetingId) {
    const db = await client();
    return unwrap(await db.rpc("family_week", { p_meeting_id: meetingId }));
  },

  /**
   * A class as a parent may see it: the class itself, this week's posts, and
   * who else is in it — names and whether they are in, and nothing more.
   */
  async familyClass(classId, meetingId = null) {
    const db = await client();
    return unwrap(await db.rpc("family_class_view", {
      p_class_id: classId, p_meeting_id: meetingId,
    }));
  },

  // --- Applications ---
  async applications() {
    const db = await client();
    return unwrap(await db.from("applications").select("*")
      .order("created_at", { ascending: false }));
  },

  async approveApplication(id, displayName) {
    const db = await client();
    return unwrap(await db.rpc("approve_application", {
      p_id: id, p_display_name: displayName,
    }));
  },

  async setApplicationStatus(id, status, notes = null) {
    const db = await client();
    return unwrap(await db.rpc("set_application_status", {
      p_id: id, p_status: status, p_notes: notes,
    }));
  },

  /** The signed-in person's own application, if they have one. */
  async myApplication() {
    const db = await client();
    return unwrap(await db.rpc("my_application"));
  },

  // --- Registration (family × semester) ---
  /** Every family's standing for one semester, including those never marked. */
  async registrationReport(semesterId) {
    const db = await client();
    return unwrap(await db.rpc("semester_registration_report",
      { p_semester_id: semesterId })) ?? [];
  },

  async setFamilyRegistration(familyId, semesterId, status, note = null) {
    const db = await client();
    return unwrap(await db.rpc("set_family_registration", {
      p_family_id: familyId, p_semester_id: semesterId,
      p_status: status, p_note: note,
    }));
  },

  /** What this family's children offered, and where they were placed. */
  async familyVolunteering(semesterId = null) {
    const db = await client();
    return unwrap(await db.rpc("family_volunteering", { p_semester_id: semesterId }));
  },

  // --- Records: what was held, and when ---
  async registrationRecord(familyId, semesterId) {
    const db = await client();
    return unwrap(await db.rpc("registration_record", {
      p_family_id: familyId, p_semester_id: semesterId,
    }));
  },

  async applicationRecord(id) {
    const db = await client();
    return unwrap(await db.rpc("application_record", { p_id: id }));
  },

  async registrationHistory(familyId) {
    const db = await client();
    return unwrap(await db.rpc("family_registration_history",
      { p_family_id: familyId })) ?? [];
  },

  // --- Family setup: a family's own standing record ---
  async familySetup() {
    const db = await client();
    return unwrap(await db.rpc("family_setup"));
  },

  async updateFamilySetup(payload) {
    const db = await client();
    return unwrap(await db.rpc("update_family_setup", { p_payload: payload }));
  },

  // --- The registration form ---
  /** What the family already has on file, plus whether a window is open. */
  async registrationForm() {
    const db = await client();
    return unwrap(await db.rpc("family_registration_form"));
  },

  async submitRegistrationForm(payload) {
    const db = await client();
    return unwrap(await db.rpc("submit_registration_form", { p_payload: payload }));
  },

  async setRegistrationReview(familyId, semesterId, reviewed) {
    const db = await client();
    return unwrap(await db.rpc("set_registration_review", {
      p_family_id: familyId, p_semester_id: semesterId, p_reviewed: reviewed,
    }));
  },

  async setRegistrationPayment(familyId, semesterId, received, note = null) {
    const db = await client();
    return unwrap(await db.rpc("set_registration_payment", {
      p_family_id: familyId, p_semester_id: semesterId,
      p_received: received, p_note: note,
    }));
  },

  /**
   * "Registration is open." To everybody, or to one family.
   *
   * familyId omitted sends to every active family with an email address; given,
   * sends to exactly that one — which is the commoner case in practice, because
   * somebody always says in September that they never got it.
   */
  async sendRegistrationNotice(semesterId, familyId = null) {
    return this.callFunction("admin-invites", {
      action: "registration_notice",
      semester_id: semesterId,
      ...(familyId ? { family_id: familyId } : {}),
    });
  },

  async registerFamily(familyId, semesterId) {
    const db = await client();
    return unwrap(await db.rpc("register_family", {
      p_family_id: familyId, p_semester_id: semesterId,
    }));
  },

  // An administrator recording an absence uses the same reportAbsence below as
  // a parent does. report_absence already lets an admin act for any child —
  // the authorization check passes for them — so no second function is needed,
  // only a button, which Admin → Absences never had.

  // --- Class proposals ---
  /** Everything the proposal page needs: who may propose, terms, what was sent. */
  async proposalPayload() {
    const db = await client();
    return unwrap(await db.rpc("family_proposal_payload"));
  },

  async submitProposal(payload) {
    const db = await client();
    return unwrap(await db.rpc("submit_class_proposal", { p_payload: payload }));
  },

  async proposals({ archived = false } = {}) {
    const db = await client();
    return unwrap(await db.from("class_proposals").select("*")
      .eq("status", archived ? "archived" : "submitted")
      .order("submitted_at", { ascending: false })) ?? [];
  },

  async archiveProposal(id, outcome = null, notes = null) {
    const db = await client();
    return unwrap(await db.rpc("archive_proposal",
      { p_id: id, p_outcome: outcome, p_notes: notes }));
  },

  async reopenProposal(id) {
    const db = await client();
    return unwrap(await db.rpc("reopen_proposal", { p_id: id }));
  },

  // --- Website text ---
  /** Every editable block on one page, in the order it appears. */
  async siteBlocks(page) {
    const db = await client();
    return unwrap(await db.from("site_content").select("*")
      .eq("page", page).order("sort_order", { ascending: true }));
  },

  /** Which pages have unpublished-looking changes, for the page list. */
  async siteEditedPages() {
    const db = await client();
    return unwrap(await db.from("site_content").select("page")
      .not("text", "is", null));
  },

  /** Blank text reverts the block to its original wording. */
  async setSiteText(page, blockKey, text) {
    const db = await client();
    return unwrap(await db.rpc("set_site_text", {
      p_page: page, p_block_key: blockKey, p_text: text,
    }));
  },

  // --- Announcements ---
  async announcements({ classId = null, semesterId = null } = {}) {
    const db = await client();
    let q = db.from("announcements")
      .select("*, meeting_dates(meets_on), classes(id, name)")
      .order("created_at", { ascending: false });
    if (classId) q = q.eq("class_id", classId);
    if (semesterId) q = q.eq("semester_id", semesterId);
    return unwrap(await q);
  },

  async postAnnouncement(fields) {
    const db = await client();
    return unwrap(await db.from("announcements").insert(fields).select().single());
  },

  async deleteAnnouncement(id) {
    const db = await client();
    return unwrap(await db.from("announcements").delete().eq("id", id));
  },

  /**
   * Upload a handout.
   *
   * The class id is the first path segment because the storage policy reads it
   * from there — the same rule that guards the row guards the file. Co-op-wide
   * handouts go under "general".
   */
  async uploadHandout(classId, file) {
    const db = await client();
    const folder = classId ?? "general";
    const safe = file.name.replace(/[^\w.\-]+/g, "_").slice(-80);
    const path = `${folder}/${crypto.randomUUID()}-${safe}`;
    const { error } = await db.storage.from("handouts").upload(path, file, { upsert: false });
    if (error) throw new Error(friendlyError(error));
    return { path, name: file.name, size: file.size };
  },

  /**
   * A time-limited URL for a handout.
   *
   * Signed rather than public: the bucket is private, and a link that worked
   * forever for anyone who had once been sent it would defeat the policy.
   */
  async handoutUrl(path, seconds = 3600) {
    const db = await client();
    const { data, error } = await db.storage.from("handouts").createSignedUrl(path, seconds);
    if (error) throw new Error(friendlyError(error));
    return data.signedUrl;
  },

  // --- Teacher administration ---
  async teachers() {
    const db = await client();
    return unwrap(await db.from("teachers")
      .select("*, class_teachers(class_id, classes(id, name, semester_id))")
      .order("display_name", { nullsFirst: false }));
  },

  async createTeacher(fields) {
    const db = await client();
    return unwrap(await db.from("teachers").insert(fields).select().single());
  },

  async updateTeacher(id, fields) {
    const db = await client();
    return unwrap(await db.from("teachers").update(fields).eq("id", id).select().single());
  },

  async assignTeacher(classId, teacherId) {
    const db = await client();
    return unwrap(await db.from("class_teachers")
      .insert({ class_id: classId, teacher_id: teacherId }).select().single());
  },

  async unassignTeacher(id) {
    const db = await client();
    return unwrap(await db.from("class_teachers").delete().eq("id", id));
  },

  async classTeachers(classId) {
    const db = await client();
    return unwrap(await db.from("class_teachers")
      .select("id, teacher_id, teachers(id, display_name, email, active)")
      .eq("class_id", classId));
  },

  /** The class days of a semester — the calendar the portal is built around. */
  async meetings(semesterId) {
    const db = await client();
    return unwrap(await db.from("meeting_dates")
      .select("*").eq("semester_id", semesterId).order("meets_on"));
  },

  async reportAbsence(childId, date, wholeDay, periodIds = [], reason = null) {
    const db = await client();
    return unwrap(await db.rpc("report_absence", {
      p_child_id: childId,
      p_date: date,
      p_whole_day: wholeDay,
      p_period_ids: periodIds,
      p_reason: reason,
    }));
  },

  async cancelAbsence(id) {
    const db = await client();
    return unwrap(await db.rpc("cancel_absence", { p_id: id }));
  },

  /** Admin: everyone away, from a date onwards. */
  async absenceReport(semesterId, from = null) {
    const db = await client();
    return unwrap(await db.rpc("absence_report", {
      p_semester_id: semesterId, p_from: from,
    })) ?? [];
  },

  async volunteers(semesterId) {
    const db = await client();
    return unwrap(await db.rpc("volunteer_report", { p_semester_id: semesterId })) ?? [];
  },

  /** Helpers assigned to one class, with their family for contact. */
  async classVolunteers(classId) {
    const db = await client();
    return unwrap(await db.from("class_volunteers")
      .select(`id, note, created_at, child_id,
               children(id, first_name, last_name, birth_date, email, phone, family_id,
                        families(display_name, primary_email, primary_phone,
                                 parents(first_name, phone, email, sort_order)))`)
      .eq("class_id", classId)
      .order("created_at"));
  },

  async checkVolunteer(childId, classId) {
    const db = await client();
    return unwrap(await db.rpc("check_volunteer_assignment",
      { p_child_id: childId, p_class_id: classId }));
  },

  async assignVolunteer(childId, classId, note = null, confirm = false) {
    const db = await client();
    return unwrap(await db.rpc("admin_assign_volunteer", {
      p_child_id: childId, p_class_id: classId, p_note: note, p_confirm: confirm,
    }));
  },

  async removeVolunteer(id) {
    const db = await client();
    return unwrap(await db.rpc("admin_remove_volunteer", { p_id: id }));
  },

  /** Who named this class as a choice, whether or not they got in. */
  async classPreferences(classId) {
    const db = await client();
    return unwrap(await db.from("class_preferences")
      .select("rank, child_id, period_id, children(id, first_name, last_name, family_id, families(display_name))")
      .eq("class_id", classId));
  },

  /** What each child asked for, including choices that were not used. */
  async preferences(semesterId) {
    const db = await client();
    return unwrap(await db.from("class_preferences")
      .select("child_id, period_id, rank, class_id")
      .eq("semester_id", semesterId));
  },

  // --- Invitations (status only; the token hash is not readable here) ---
  async invites(semesterId) {
    const db = await client();
    return unwrap(await db.from("registration_invites")
      .select("id, family_id, semester_id, created_at, expires_at, revoked_at, sent_at, send_error, last_used_at")
      .eq("semester_id", semesterId)
      .is("revoked_at", null));
  },

  // --- Settings, admins, audit ---
  async settings()          { const db = await client(); return unwrap(await db.from("settings").select("*").eq("id", 1).single()); },
  async updateSettings(f)   { const db = await client(); return unwrap(await db.from("settings").update(f).eq("id", 1).select().single()); },
  async admins()            { const db = await client(); return unwrap(await db.from("admins").select("*").order("email")); },
  async createAdmin(f)      { const db = await client(); return unwrap(await db.from("admins").insert(f).select().single()); },
  async updateAdmin(id, f)  { const db = await client(); return unwrap(await db.from("admins").update(f).eq("id", id).select().single()); },

  async auditLog(limit = 100) {
    const db = await client();
    return unwrap(await db.from("audit_log").select("*")
      .order("created_at", { ascending: false }).limit(limit));
  },

  async systemStatus() {
    const db = await client();
    return unwrap(await db.from("system_status").select("*").eq("id", 1).single());
  },

  // --- Edge Functions (need a secret server-side, so they are not table calls) ---
  async callFunction(name, body) {
    const token = await auth.accessToken();
    const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token ?? SUPABASE_ANON_KEY}`,
        "apikey": SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(body),
    });
    let data;
    try { data = await res.json(); } catch { data = { ok: false, error: `HTTP ${res.status}` }; }
    return data;
  },

  openRegistration(semesterId, force = false) {
    return this.callFunction("admin-invites",
      { action: "open_registration", semester_id: semesterId, force });
  },

  resendInvite(familyId, semesterId) {
    return this.callFunction("admin-invites",
      { action: "resend", family_id: familyId, semester_id: semesterId });
  },

  revokeInvite(familyId, semesterId) {
    return this.callFunction("admin-invites",
      { action: "revoke", family_id: familyId, semester_id: semesterId });
  },
};

// =============================================================================
// Family access.
//
// No Supabase client, no session, no key beyond the public anon key used to
// reach the function at all. The invitation token is the entire credential, and
// it is re-validated server-side on every call.
// =============================================================================
export const familyApi = {
  async post(name, body) {
    const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        "apikey": SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(body),
    });
    try {
      return await res.json();
    } catch {
      return { ok: false, error: "server_error" };
    }
  },

  session(token) { return this.post("family-session", { token }); },

  /**
   * selections carry `rank` (1 = first choice, 2 = fallback).
   * notParticipating is the child ids sitting this semester out.
   * volunteer is keyed by child id: { wants, note, slots:[{period_id, class_id}] }.
   */
  submit(token, selections, notParticipating = [], volunteer = {}) {
    return this.post("family-submit", {
      token, selections,
      not_participating: notParticipating,
      volunteer,
    });
  },
};
