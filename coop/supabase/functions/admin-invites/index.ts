// Administrator invitation operations (§23, §24, §39).
//
// These live server-side for two reasons: minting a token requires the database
// function no browser may call, and sending mail requires the Brevo key. Every
// request re-verifies that the caller is an active administrator; being able to
// reach this URL proves nothing.
//
// POST { action: "open_registration", semester_id, force? }
//   Preflight, mint an invitation for every eligible active family, mail them
//   all, and move the semester to registration_open.
//
// POST { action: "resend", family_id, semester_id }
//   Re-send the existing invitation, or mint one if there isn't a live one.
//
// POST { action: "reissue", family_id, semester_id }
//   Revoke the old link and send a new one — for when a link was forwarded to
//   the wrong person.
//
// POST { action: "revoke", family_id, semester_id }
//   Kill the link without issuing a replacement.

import { json, preflight, requireAdmin, serviceClient, type SupabaseClient } from "../_shared/deps.ts";
import { invitationEmail, registrationNoticeEmail, openMailer, type Mailer }
  from "../_shared/email.ts";

interface Settings {
  program_name: string;
  registration_base_url: string | null;
  timezone: string;
}

function formatClosing(iso: string | null, tz: string): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      timeZone: tz, month: "long", day: "numeric", year: "numeric",
    });
  } catch {
    return null;
  }
}

/** Mint a token, mail it, and record what happened on the invitation row. */
async function issueAndSend(
  db: SupabaseClient,
  mailer: Mailer,
  family: { id: string; display_name: string; primary_email: string | null },
  semester: { id: string; name: string; registration_close_at: string | null },
  settings: Settings,
): Promise<{ ok: boolean; error?: string }> {
  if (!family.primary_email) {
    return { ok: false, error: "No email address on file" };
  }
  if (!settings.registration_base_url) {
    return { ok: false, error: "Registration link address is not set in Settings" };
  }

  const { data: issued, error } = await db.rpc("issue_family_invite", {
    p_family_id: family.id,
    p_semester_id: semester.id,
  });
  if (error || !issued?.token) {
    return { ok: false, error: error?.message ?? "Could not create invitation" };
  }

  // The token goes in the URL fragment. Fragments are not sent to the server on
  // the initial request, so the secret stays out of GitHub Pages' access logs
  // and out of any Referer header the page later emits (§15).
  const base = settings.registration_base_url.replace(/#.*$/, "");
  const url = `${base}${base.endsWith("/") ? "" : "/"}#${issued.token}`;

  const mail = invitationEmail({
    programName: settings.program_name,
    familyName: family.display_name,
    semesterName: semester.name,
    registerUrl: url,
    closesAt: formatClosing(semester.registration_close_at, settings.timezone),
  });
  mail.to = family.primary_email;
  mail.toName = family.display_name;

  const sent = await mailer.send(mail);

  await db.from("registration_invites")
    .update({
      sent_at: sent.ok ? new Date().toISOString() : null,
      send_error: sent.ok ? null : (sent.error ?? "Unknown send failure"),
    })
    .eq("id", issued.invite_id);

  return sent;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") {
    return json(req, { ok: false, error: "method_not_allowed" }, 405);
  }

  const db = serviceClient();
  const admin = await requireAdmin(req, db);
  if (!admin) return json(req, { ok: false, error: "not_authorized" }, 403);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json(req, { ok: false, error: "bad_request" }, 400);
  }

  const { data: settings } = await db.from("settings").select("*").eq("id", 1).single();
  if (!settings) return json(req, { ok: false, error: "settings_missing" }, 500);

  const { data: semester } = await db
    .from("semesters")
    .select("id, name, status, registration_close_at, registration_form_closes_at")
    .eq("id", body.semester_id)
    .maybeSingle();
  if (!semester) return json(req, { ok: false, error: "semester_not_found" }, 404);

  // ---------------------------------------------------------------------------
  switch (body.action) {
    // -------------------------------------------------------------------------
    // "Registration is open — come and register."
    //
    // Two shapes, one path: every family, or one named family. A one-off
    // matters because the commonest real case is not a batch at all — it is a
    // family who says in September that they never got it, and somebody wants
    // to send that one email without spamming fifty-nine others.
    //
    // No tokens. This points at the portal, where a family signs in with the
    // address the co-op already holds, so a forwarded copy is useless to
    // anybody else rather than being a way into somebody's registration.
    // -------------------------------------------------------------------------
    case "registration_notice": {
      if (!settings.registration_base_url) {
        return json(req, { ok: false, error: "no_base_url" }, 400);
      }
      // …/coop/register/ is the class sign-up page; the portal is its sibling.
      const portalUrl = settings.registration_base_url
        .replace(/#.*$/, "")
        .replace(/register\/?$/, "portal/");

      let q = db.from("families")
        .select("id, display_name, primary_email")
        .eq("active", true)
        .is("archived_at", null)
        .order("display_name");

      if (body.family_id) q = q.eq("id", body.family_id);

      const { data: families } = await q;
      const targets = (families ?? []).filter((f) => f.primary_email);
      const noEmail = (families ?? []).length - targets.length;

      if (!targets.length) {
        return json(req, { ok: false, error: "nobody_to_email", no_email: noEmail }, 400);
      }

      const closing = formatClosing(
        semester.registration_form_closes_at ?? null, settings.timezone);

      const mailer = await openMailer(db);
      const sent: string[] = [];
      const failed: { family: string; error: string }[] = [];

      for (const f of targets) {
        const email = registrationNoticeEmail({
          programName: settings.program_name,
          familyName: f.display_name,
          semesterName: semester.name,
          portalUrl,
          closesAt: closing,
        });
        try {
          await mailer.send({ ...email, to: f.primary_email! });
          sent.push(f.display_name);
        } catch (e) {
          failed.push({ family: f.display_name, error: String(e) });
        }
      }
      await mailer.close();

      await db.rpc("write_audit", {
        p_action: "registration_notice_sent",
        p_entity: "semester",
        p_entity_id: semester.id,
        p_details: {
          sent: sent.length,
          failed: failed.length,
          no_email: noEmail,
          one_off: !!body.family_id,
        },
      });

      return json(req, {
        ok: true, sent: sent.length, failed, no_email: noEmail,
      });
    }

    case "open_registration": {
      const { data: pf } = await db.rpc("registration_preflight", {
        p_semester_id: semester.id,
      });

      // Blocking problems stop the process unless the admin has seen them and
      // chosen to continue anyway (§23).
      if (pf?.blocking && !body.force) {
        return json(req, { ok: false, error: "preflight_blocked", preflight: pf }, 409);
      }

      // Only families registered for this semester (0023).
      //
      // The gate that actually matters is in submit_family_registration — a
      // link in an old email must not be a way round it. But sending a
      // sign-up email to an unregistered family would have them fill in the
      // whole form and be refused at the last step, which is a worse way to
      // learn they are not registered than never being asked.
      const { data: registered } = await db
        .from("semester_registrations")
        .select("family_id")
        .eq("semester_id", semester.id)
        .eq("status", "registered");

      const eligible = new Set((registered ?? []).map((r) => r.family_id));

      const { data: allFamilies } = await db
        .from("families")
        .select("id, display_name, primary_email")
        .eq("active", true)
        .is("archived_at", null)
        .order("display_name");

      const families = (allFamilies ?? []).filter((f) => eligible.has(f.id));
      const skipped = (allFamilies ?? []).length - families.length;

      // One SMTP connection for the whole co-op, not one per family.
      const mailer = await openMailer(db);
      const results: { family: string; ok: boolean; error?: string }[] = [];
      try {
        for (const f of families ?? []) {
          const r = await issueAndSend(db, mailer, f, semester, settings);
          results.push({ family: f.display_name, ok: r.ok, error: r.error });
        }
      } finally {
        await mailer.close();
      }

      await db.from("semesters")
        .update({ status: "registration_open" })
        .eq("id", semester.id);

      const failed = results.filter((r) => !r.ok);
      await db.from("audit_log").insert({
        actor_type: "admin",
        actor_id: admin.id,
        actor_label: admin.display_name ?? admin.email,
        action: "registration_opened",
        entity_type: "semester",
        entity_id: semester.id,
        details: { invited: results.length, failed: failed.length,
                   not_registered: skipped, forced: !!body.force },
      });

      return json(req, {
        ok: true,
        invited: results.length,
        failed: failed.length,
        results,
        preflight: pf,
      });
    }

    case "resend":
    case "reissue": {
      const { data: family } = await db
        .from("families")
        .select("id, display_name, primary_email")
        .eq("id", body.family_id)
        .maybeSingle();
      if (!family) return json(req, { ok: false, error: "family_not_found" }, 404);

      // Both paths mint a fresh token. issue_family_invite revokes any previous
      // one, so a "resend" quietly supersedes the old link rather than mailing
      // a duplicate — which is the behaviour an admin actually wants when a
      // parent says "I can't find the email."
      const mailer = await openMailer(db);
      let r: { ok: boolean; error?: string };
      try {
        r = await issueAndSend(db, mailer, family, semester, settings);
      } finally {
        await mailer.close();
      }

      await db.from("audit_log").insert({
        actor_type: "admin",
        actor_id: admin.id,
        actor_label: admin.display_name ?? admin.email,
        action: body.action === "reissue" ? "invitation_reissued" : "invitation_resent",
        entity_type: "family",
        entity_id: family.id,
        details: { semester_id: semester.id, ok: r.ok, error: r.error ?? null },
      });

      return json(req, r, r.ok ? 200 : 502);
    }

    case "revoke": {
      await db.from("registration_invites")
        .update({ revoked_at: new Date().toISOString() })
        .eq("family_id", body.family_id)
        .eq("semester_id", semester.id)
        .is("revoked_at", null);

      await db.from("audit_log").insert({
        actor_type: "admin",
        actor_id: admin.id,
        actor_label: admin.display_name ?? admin.email,
        action: "invitation_revoked",
        entity_type: "family",
        entity_id: body.family_id,
        details: { semester_id: semester.id },
      });

      return json(req, { ok: true });
    }

    default:
      return json(req, { ok: false, error: "unknown_action" }, 400);
  }
});
