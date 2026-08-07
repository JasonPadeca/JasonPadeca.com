// POST { token } -> everything the family registration page needs, and nothing
// more (§28, §29).
//
// This is the only door a family's browser ever knocks on for data. The token
// arrives in the request body rather than the URL so it stays out of server
// logs, referrer headers, and browser history.

import { json, preflight, serviceClient } from "../_shared/deps.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== "POST") {
    return json(req, { ok: false, error: "method_not_allowed" }, 405);
  }

  let token = "";
  try {
    token = (await req.json())?.token ?? "";
  } catch {
    return json(req, { ok: false, error: "bad_request" }, 400);
  }
  if (typeof token !== "string" || token.length < 20) {
    return json(req, { ok: false, error: "invalid" }, 401);
  }

  const db = serviceClient();

  const { data: resolved, error: rErr } = await db.rpc("resolve_invite_token", {
    p_token: token,
  });
  if (rErr) {
    console.error("resolve_invite_token failed", rErr);
    return json(req, { ok: false, error: "server_error" }, 500);
  }

  // invalid / revoked / expired are all answered identically in shape, so the
  // response cannot be used to probe which tokens exist.
  if (!resolved?.ok) {
    return json(req, { ok: false, error: resolved?.error ?? "invalid" }, 401);
  }

  const { data: payload, error: pErr } = await db.rpc(
    "family_registration_payload",
    { p_family_id: resolved.family_id, p_semester_id: resolved.semester_id },
  );
  if (pErr) {
    console.error("family_registration_payload failed", pErr);
    return json(req, { ok: false, error: "server_error" }, 500);
  }

  return json(req, payload);
});
