// =============================================================================
// submit-application
//
// The one endpoint on this project a complete stranger is meant to reach. It
// takes the membership application from the public site and files it.
//
// It runs server-side rather than letting the browser insert directly, for the
// same reason request-signin does: the anon key is printed in the page source,
// so anything the browser can do, anybody can do. Here that means the row is
// written with the service role and the browser never touches the table.
//
// Deliberately NOT done here: creating an auth user. Applying should not mint
// an account for an address nobody has verified. The applicant signs in
// afterwards through the ordinary code-by-email flow, which proves the address
// is theirs — and request-signin recognises an open applicant so that works.
// =============================================================================

import { json, preflight, serviceClient } from "../_shared/deps.ts";

const MAX = {
  parent_names: 200,
  email: 200,
  phone: 60,
  children_text: 2000,
  heard_about: 500,
  homeschool_journey: 4000,
  about_yourself: 4000,
  looking_for: 4000,
};

Deno.serve(async (req: Request): Promise<Response> => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== "POST") {
    return json(req, { ok: false, error: "method_not_allowed" }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(req, { ok: false, error: "bad_request" }, 400);
  }

  const str = (k: keyof typeof MAX) =>
    String(body[k] ?? "").trim().slice(0, MAX[k]);

  const email = str("email").toLowerCase();
  const parentNames = str("parent_names");
  const childrenText = str("children_text");

  if (!parentNames) {
    return json(req, { ok: false, error: "missing", field: "parent_names" });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(req, { ok: false, error: "invalid_email" });
  }
  if (!childrenText) {
    return json(req, { ok: false, error: "missing", field: "children_text" });
  }
  if (body.agrees_to_beliefs !== true) {
    return json(req, { ok: false, error: "must_agree" });
  }

  // A honeypot: a field hidden from people and irresistible to bots. Anything
  // that fills it in is told the application was received and quietly discarded,
  // because telling a bot it was caught only teaches it to try again.
  if (String(body.website ?? "").trim() !== "") {
    return json(req, { ok: true });
  }

  const db = serviceClient();

  const { error } = await db.from("applications").insert({
    parent_names: parentNames,
    email,
    phone: str("phone") || null,
    children_text: childrenText,
    agrees_to_beliefs: true,
    heard_about: str("heard_about") || null,
    homeschool_journey: str("homeschool_journey") || null,
    about_yourself: str("about_yourself") || null,
    looking_for: str("looking_for") || null,
  });

  if (error) {
    // The partial unique index means one open application per address. That is
    // not an error to a family who clicked twice, or who forgot they applied
    // last month — it is the answer to their question.
    if (/duplicate|unique/i.test(error.message)) {
      return json(req, { ok: false, error: "already_applied" });
    }
    console.error("application insert failed", error.message);
    return json(req, { ok: false, error: "failed" }, 500);
  }

  return json(req, { ok: true });
});
