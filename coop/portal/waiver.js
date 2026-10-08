// =============================================================================
// The medical, handbook and photography release, ready to print.
//
// Three separate agreements that happen to live on one sheet, each with its
// own signature line. They stay separate here too: a family may well agree to
// the medical release and not to photographs, and collapsing them would record
// a consent nobody gave.
//
// Deliberately NOT a form. Nothing here is signed, ticked or submitted — the
// medical release authorises adults to consent to surgery on somebody's child,
// and whether a typed name is good enough for that is a question for the
// church's own advisers rather than something to decide by building it. So the
// page prints, and the paper is carried in, exactly as it is now.
//
// What it changes is that the sheet arrives already filled in with the
// children's names, ages and dates of birth. The co-op holds all of that; the
// old sheet made a mother write it out again, in a grid of six empty rows,
// having just typed the same thing into the registration form.
// =============================================================================

import { esc } from "../assets/ui.js";

/** Age on a given date, from the parts — never `new Date(string)`. */
function ageOn(birthDate, onISO) {
  if (!birthDate) return null;
  const [by, bm, bd] = birthDate.split("-").map(Number);
  const [ry, rm, rd] = (onISO ?? new Date().toISOString().slice(0, 10))
    .split("-").map(Number);
  let a = ry - by;
  if (rm < bm || (rm === bm && rd < bd)) a -= 1;
  return a >= 0 ? a : null;
}

function fmtUK(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/**
 * @param family   { display_name, primary_phone }
 * @param children [{ first_name, last_name, birth_date }]
 * @param semester { name, class_start_date }
 */
export function waiverSheet(family, children, semester) {
  // Six rows on the paper form. Keep six, so it looks like the sheet the
  // leadership already knows, with the blanks left for anybody not on file.
  const rows = [...(children ?? [])];
  while (rows.length < 6) rows.push(null);

  const refDate = semester?.class_start_date;

  const line = (label, value = "") => `
    <div class="wv-line">
      <span class="wv-label">${esc(label)}</span>
      <span class="wv-rule">${value ? esc(value) : ""}</span>
    </div>`;

  return `
  <div class="waiver-sheet">

    <header class="wv-head">
      <img src="../assets/koinonia-logo.jpg" alt="" width="64" height="64">
      <div>
        <h1>Medical and Liability Release for Participants</h1>
        <div class="wv-sub">Koinonia Homeschool Group — a ministry of North Mountain Church
          ${semester?.name ? ` · ${esc(semester.name)}` : ""}</div>
      </div>
    </header>

    <table class="wv-kids">
      <thead><tr><th>Name of minor child</th><th class="num">Age</th><th>Date of birth</th></tr></thead>
      <tbody>${rows.map((c) => c ? `<tr>
          <td><strong>${esc(c.first_name)} ${esc(c.last_name ?? "")}</strong></td>
          <td class="num">${ageOn(c.birth_date, refDate) ?? ""}</td>
          <td>${esc(fmtUK(c.birth_date))}</td>
        </tr>` : `<tr class="wv-blank"><td></td><td></td><td></td></tr>`).join("")}
      </tbody>
    </table>

    <p>I hereby consent to the above child/children participating in Koinonia
      Homeschool Group (a ministry of North Mountain Church). I understand that
      all care will be taken to ensure the health and safety of my children.</p>

    <p>I further understand that in the event medical intervention is needed,
      every attempt will be made to contact the adults on this form. In the event
      I cannot be reached, I authorize adult volunteers of Koinonia Homeschool
      Group (a ministry of North Mountain Church), to consent to any medical or
      surgical care deemed advisable by any accredited physician or surgeon in an
      approved emergency clinic or hospital.</p>

    <p>I further release from any liability Koinonia Homeschool Group (a ministry
      of North Mountain Church), and any of its ministries, leaders, employees,
      and volunteer staff in the event of damages, losses, diseases, or injuries
      incurred by the child/children on this form.</p>

    <div class="wv-sign">
      ${line("Parent's name (printed)")}
      ${line("Parent's signature")}
      ${line("Date")}
      ${line("Cell phone number", family?.primary_phone ?? "")}
    </div>
  </div>

  <div class="waiver-sheet wv-break">
    <h2>Koinonia Handbook Acknowledgement Form</h2>

    <p>Please read the following statements and sign below to indicate your
      receipt and acknowledgment of this Koinonia Homeschool Group Handbook.</p>

    <p>I have received and read a copy of Koinonia Homeschool Group Handbook. I
      understand that the policies described in it are subject to change at the
      discretion of the leadership team at any time.</p>

    <p>I understand that my signature below indicates that I have read and
      understand the above statements and that I have received a copy in either
      paper form or have access to an electronic copy of the Koinonia Homeschool
      Group Handbook.</p>

    <p class="wv-aside">The signed original copy of this acknowledgement should
      be given to the leadership team to be filed.</p>

    <div class="wv-sign">
      ${line("Member's name (printed)")}
      ${line("Member's signature")}
      ${line("Date")}
    </div>
  </div>

  <div class="waiver-sheet wv-break">
    <h2>Photography and Videography Release</h2>

    <p>I hereby grant permission for Koinonia Homeschool Group (a ministry of
      North Mountain Church) to use images (photos and / or videos) of my
      child/children for this group and to publicize the ministries of North
      Mountain Church.</p>

    <p class="wv-aside">This one is separate on purpose. If you would rather
      your children were not photographed, simply do not sign this page — the
      other two are unaffected.</p>

    <div class="wv-sign">
      ${line("Member's name (printed)")}
      ${line("Member's signature")}
      ${line("Date")}
    </div>
  </div>`;
}
