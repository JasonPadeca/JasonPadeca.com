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
    return "Registration must close after it opens.";
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

    const seats = unwrap(await db.from("class_seats").select("*")
      .in("class_id", rows.map((c) => c.id)));
    const byId = new Map(seats.map((s) => [s.class_id, s]));
    return rows.map((c) => ({ ...c, seats: byId.get(c.id) ?? {} }));
  },

  async klass(id) {
    const db = await client();
    // periods and semesters embed fine — those are real foreign keys.
    const row = unwrap(await db.from("classes")
      .select("*, periods(*), semesters(*)").eq("id", id).single());
    const seats = unwrap(await db.from("class_seats").select("*")
      .eq("class_id", id).maybeSingle());
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
