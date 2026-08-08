// =============================================================================
// Application for membership.
//
// The only page on this project a stranger is meant to use, so it assumes
// nothing: no session, no account, no prior visit. It posts to an Edge Function
// rather than writing to the database, because the key in this page's source is
// public and anything the browser may do, anybody may do.
//
// The questions are the ones the co-op already asks on paper. Rewording them to
// suit a database would lose the thing that makes them useful — they are how the
// leadership decides whether a family is a fit, which is a judgement, not a
// filter.
// =============================================================================

import { SUPABASE_ANON_KEY, FUNCTIONS_URL, IS_CONFIGURED } from "../assets/config.js";
import { esc, $, render, toastErr } from "../assets/ui.js";

const form = document.getElementById("form");

const FIELDS = [
  { name: "parent_names", label: "Parents' names", required: true,
    placeholder: "Sarah and Michael Thompson" },
  { name: "email", label: "Email", type: "email", required: true,
    hint: "This is the address you will sign in with to follow your application." },
  { name: "phone", label: "Phone", type: "tel" },
  { name: "children_text", label: "Children's names, ages, and grades",
    type: "textarea", required: true, rows: 3,
    placeholder: "Emma, 12, 7th grade\nCaleb, 9, 4th grade" },
  { name: "heard_about", label: "How did you hear about Koinonia Homeschool Group?" },
  { name: "homeschool_journey", label: "Tell us about your homeschool journey.",
    type: "textarea", required: true, rows: 4 },
  { name: "about_yourself",
    label: "Tell us a little about yourself. What are your interests and background?",
    type: "textarea", required: true, rows: 4 },
  { name: "looking_for",
    label: "Tell us about what you are looking for in a homeschool group.",
    type: "textarea", required: true, rows: 4 },
];

function draw() {
  if (!IS_CONFIGURED) {
    return render(form, `<div class="note note-danger">
      This form is not connected yet.</div>`);
  }

  render(form, `
    <form id="applyform" novalidate>
      ${FIELDS.map((f) => `
        <div class="field">
          <label for="f-${f.name}">${esc(f.label)}${
            f.required ? "" : ` <span class="faint">(optional)</span>`}</label>
          ${f.type === "textarea"
            ? `<textarea id="f-${f.name}" name="${f.name}" rows="${f.rows ?? 3}"
                 placeholder="${esc(f.placeholder ?? "")}"></textarea>`
            : `<input type="${f.type ?? "text"}" id="f-${f.name}" name="${f.name}"
                 placeholder="${esc(f.placeholder ?? "")}"
                 ${f.type === "email" ? 'autocapitalize="off" spellcheck="false"' : ""}>`}
          ${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ""}
        </div>`).join("")}

      <div class="field">
        <label class="check">
          <input type="checkbox" id="f-agree">
          <span>I have read and agree to abide by Koinonia's
            <a href="../beliefs.html" target="_blank" rel="noopener">Statement of
            Faith and Code of Conduct</a>.</span>
        </label>
      </div>

      <!-- Hidden from people, irresistible to the scripts that fill in every
           field they find. Anything that types here is thanked and discarded. -->
      <div class="hp" aria-hidden="true">
        <label for="f-website">Website</label>
        <input type="text" id="f-website" name="website" tabindex="-1" autocomplete="off">
      </div>

      <button class="btn btn-primary btn-lg" type="submit" id="send">
        Send application
      </button>
    </form>`);

  $("#applyform").addEventListener("submit", submit);
}

async function submit(e) {
  e.preventDefault();

  const body = {};
  for (const f of FIELDS) body[f.name] = $(`#f-${f.name}`).value.trim();
  body.agrees_to_beliefs = $("#f-agree").checked;
  body.website = $("#f-website").value;

  const missing = FIELDS.find((f) => f.required && !body[f.name]);
  if (missing) {
    toastErr(`${missing.label} is needed.`);
    $(`#f-${missing.name}`).focus();
    return;
  }
  if (!body.agrees_to_beliefs) {
    toastErr("Please read and agree to the Statement of Faith and Code of Conduct.");
    return;
  }

  const btn = $("#send");
  btn.disabled = true;
  btn.textContent = "Sending…";

  let res;
  try {
    const r = await fetch(`${FUNCTIONS_URL}/submit-application`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(body),
    });
    res = await r.json();
  } catch {
    btn.disabled = false;
    btn.textContent = "Send application";
    return toastErr("Could not reach the server. Check your connection and try again.");
  }

  if (res?.ok) return done(body.email);

  btn.disabled = false;
  btn.textContent = "Send application";

  switch (res?.error) {
    case "already_applied":
      return render(form, `<div class="note">
        <strong>You have already applied with that address.</strong>
        <p class="mt">We have your application and somebody will be in touch. You can
          <a href="../portal/">sign in</a> with ${esc(body.email)} to see where it
          stands.</p></div>`);
    case "invalid_email":
      return toastErr("That does not look like an email address.");
    case "must_agree":
      return toastErr("Please read and agree to the Statement of Faith and Code of Conduct.");
    case "missing":
      return toastErr("Something required was left blank.");
    default:
      return toastErr("Something went wrong sending your application. Please try again.");
  }
}

function done(email) {
  render(form, `<div class="card">
    <h2>Thank you</h2>
    <p class="mt">Your application has been sent to the leadership team. Expect us
      to be in touch soon.</p>
    <p class="mt">You can <a href="../portal/">sign in</a> with
      <strong>${esc(email)}</strong> at any time to see where your application
      stands. There is no password — we email you a code.</p>
  </div>`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

draw();
