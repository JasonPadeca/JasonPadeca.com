// Shared plumbing for every Edge Function: CORS, JSON responses, and a
// service-role Supabase client.
//
// The service role key is read from the environment and never leaves this
// process. Nothing in coop/assets/js/ has any notion of it.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

export type { SupabaseClient };

// GitHub Pages serves the front-end from a different origin than Supabase, so
// every function needs CORS. ALLOWED_ORIGINS is a comma-separated list set as a
// function secret; requests from anywhere else get no CORS headers back, which
// is what stops a random page from driving these endpoints with a stolen token.
const allowed = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const ok = allowed.length === 0 || allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? (origin || "*") : "null",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

export function preflight(req: Request): Response | null {
  return req.method === "OPTIONS"
    ? new Response("ok", { headers: corsHeaders(req) })
    : null;
}

/** Full-privilege client. RLS does not apply; be deliberate about what you read. */
export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

/**
 * Resolve the caller's admin row from their Authorization header, or null.
 *
 * Admin-facing Edge Functions exist for the few operations that need a secret
 * (sending mail, minting tokens). They still verify the caller independently
 * rather than trusting that RLS elsewhere did it.
 */
export async function requireAdmin(req: Request, db: SupabaseClient) {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return null;

  const { data: { user }, error } = await db.auth.getUser(token);
  if (error || !user) return null;

  const { data: admin } = await db
    .from("admins")
    .select("id, email, display_name, role, active")
    .or(`auth_user_id.eq.${user.id},email.ilike.${user.email}`)
    .eq("active", true)
    .maybeSingle();

  return admin ?? null;
}

/** Escape untrusted text before it goes into an HTML email body. */
export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!
  ));
}
