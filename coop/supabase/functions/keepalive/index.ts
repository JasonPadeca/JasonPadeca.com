// Keeps the free Supabase project from being paused for inactivity (§31).
//
// Called every six hours by .github/workflows/keepalive.yml. It touches exactly
// one row and returns exactly one timestamp — there is deliberately nothing
// here worth finding.
//
// The shared secret is not really a security boundary (nothing behind it is
// sensitive); it just stops a crawler that stumbles on the URL from generating
// pointless function invocations.

import { json, preflight, serviceClient } from "../_shared/deps.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const expected = Deno.env.get("KEEPALIVE_SECRET");
  if (expected) {
    const given = req.headers.get("x-keepalive-secret") ??
      new URL(req.url).searchParams.get("secret") ?? "";
    if (given !== expected) {
      return json(req, { ok: false }, 403);
    }
  }

  const db = serviceClient();
  const { data, error } = await db.rpc("keepalive");

  if (error) {
    console.error("keepalive failed", error);
    return json(req, { ok: false }, 500);
  }
  return json(req, data);
});
