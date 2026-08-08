// POST { token, selections } -> commits the family's registration (§40).
//
// The ordering here is the point of §25: the database transaction commits
// first, the browser is told it succeeded, and only then do we try to send mail.
// A bounced confirmation email is an annoyance to be resolved from the admin
// screen. It is never a reason to un-enroll a child.

import { json, preflight, serviceClient } from "../_shared/deps.ts";
import { confirmationEmail, sendEmail, type ChildSchedule } from "../_shared/email.ts";

interface Selection {
  child_id: string;
  class_id: string;
  intent?: "register" | "waitlist";
  /** 1 = first choice, 2 = the fallback if the first is full. */
  rank?: number;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== "POST") {
    return json(req, { ok: false, error: "method_not_allowed" }, 405);
  }

  let token = "", selections: Selection[] = [], notParticipating: string[] = [];
  let volunteer: Record<string, unknown> = {};
  try {
    const body = await req.json();
    token = body?.token ?? "";
    selections = Array.isArray(body?.selections) ? body.selections : [];
    notParticipating = Array.isArray(body?.not_participating) ? body.not_participating : [];
    volunteer = (body?.volunteer && typeof body.volunteer === "object" &&
                 !Array.isArray(body.volunteer)) ? body.volunteer : {};
  } catch {
    return json(req, { ok: false, error: "bad_request" }, 400);
  }

  if (typeof token !== "string" || token.length < 20) {
    return json(req, { ok: false, error: "invalid" }, 401);
  }
  // A whole co-op's worth of selections is well under this; the cap just stops
  // an enormous body from tying up a transaction.
  if (selections.length > 200) {
    return json(req, { ok: false, error: "too_many_selections" }, 400);
  }

  // Normalize rather than trust: strip anything the client invented, so the
  // only fields reaching the database are the three that mean something.
  const clean = selections
    .filter((s) => s && typeof s.child_id === "string" && typeof s.class_id === "string")
    .map((s) => ({
      child_id: s.child_id,
      class_id: s.class_id,
      intent: s.intent === "waitlist" ? "waitlist" : "register",
      rank: s.rank === 2 ? 2 : 1,
    }));

  const db = serviceClient();

  const { data: resolved, error: rErr } = await db.rpc("resolve_invite_token", {
    p_token: token,
  });
  if (rErr) {
    console.error("resolve_invite_token failed", rErr);
    return json(req, { ok: false, error: "server_error" }, 500);
  }
  if (!resolved?.ok) {
    return json(req, { ok: false, error: resolved?.error ?? "invalid" }, 401);
  }

  // ---------------------------------------------------------------------------
  // The transaction. Child ownership, eligibility, capacity, one-class-per-
  // period, and the registration window are all re-checked in here — the token
  // establishes which family is asking, and nothing else is taken on trust.
  // ---------------------------------------------------------------------------
  // Only well-formed uuids reach the database; the function itself then
  // restricts them to this family's children.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const sittingOut = notParticipating.filter((id) => typeof id === "string" && UUID.test(id));

  // Normalise the volunteer payload to the exact shape the function expects.
  // The database restricts it to this family's children regardless.
  const cleanVolunteer: Record<string, unknown> = {};
  for (const [childId, raw] of Object.entries(volunteer)) {
    if (!UUID.test(childId) || !raw || typeof raw !== "object") continue;
    const v = raw as { wants?: unknown; note?: unknown; slots?: unknown };
    const slots = Array.isArray(v.slots) ? v.slots : [];
    cleanVolunteer[childId] = {
      wants: v.wants === true,
      note: typeof v.note === "string" ? v.note.slice(0, 500) : null,
      slots: slots
        .filter((s: any) => s && UUID.test(String(s.period_id ?? "")))
        .slice(0, 60)
        .map((s: any) => ({
          period_id: s.period_id,
          class_id: UUID.test(String(s.class_id ?? "")) ? s.class_id : null,
        })),
    };
  }

  const { data: result, error: sErr } = await db.rpc("submit_family_registration", {
    p_family_id: resolved.family_id,
    p_semester_id: resolved.semester_id,
    p_selections: clean,
    p_actor: "family",
    p_allow_closed: false,
    p_not_participating: sittingOut,
    p_volunteer: cleanVolunteer,
  });

  if (sErr) {
    console.error("submit_family_registration failed", sErr);
    return json(req, { ok: false, error: "server_error" }, 500);
  }
  if (!result?.ok) {
    return json(req, result, 409);
  }

  // Registration is now committed and authoritative. Everything below is
  // notification, and every failure path returns 200.
  let emailed = false, emailError: string | null = null;

  try {
    const { data: payload } = await db.rpc("family_registration_payload", {
      p_family_id: resolved.family_id,
      p_semester_id: resolved.semester_id,
    });

    if (payload?.ok && payload.family?.primary_email) {
      const classById = new Map<string, { name: string; period: string }>();
      for (const p of payload.periods ?? []) {
        for (const c of p.classes ?? []) {
          classById.set(c.id, { name: c.name, period: p.display_name });
        }
      }

      const schedules: ChildSchedule[] = (payload.children ?? []).map((ch: any) => ({
        childName: `${ch.first_name} ${ch.last_name ?? ""}`.trim(),
        rows: (payload.registrations ?? [])
          .filter((r: any) => r.child_id === ch.id)
          .map((r: any) => ({
            period: classById.get(r.class_id)?.period ?? "",
            className: classById.get(r.class_id)?.name ?? "",
            waitlisted: r.status === "waitlisted",
            position: r.waitlist_position,
          }))
          .sort((a: any, b: any) => a.period.localeCompare(b.period)),
      }));

      const { data: settings } = await db.from("settings").select("*").eq("id", 1).single();
      const base = settings?.registration_base_url;

      const mail = confirmationEmail({
        programName: payload.program_name ?? "Homeschool Co-op",
        familyName: payload.family.display_name,
        semesterName: payload.semester.name,
        schedules,
        manageUrl: base && payload.allow_edits && payload.semester.is_open
          ? `${base}#${token}` : undefined,
      });
      mail.to = payload.family.primary_email;
      mail.toName = payload.family.display_name;

      const sent = await sendEmail(db, mail);
      emailed = sent.ok;
      emailError = sent.error ?? null;
    } else {
      emailError = "No email address on file for this family";
    }
  } catch (e) {
    emailError = e instanceof Error ? e.message : String(e);
  }

  if (!emailed) {
    // Surfaced on the admin dashboard with a Resend button (§25).
    console.error("confirmation email not sent", emailError);
    await db.from("audit_log").insert({
      actor_type: "system",
      action: "confirmation_email_failed",
      entity_type: "family",
      entity_id: resolved.family_id,
      details: { semester_id: resolved.semester_id, error: emailError },
    });
  }

  return json(req, { ...result, emailed, email_error: emailError });
});
