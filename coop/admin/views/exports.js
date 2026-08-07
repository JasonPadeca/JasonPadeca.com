// =============================================================================
// Exports (§33).
//
// The database is the system of record now, but administrators still need to
// print a roster, mail-merge a list, or hand a spreadsheet to someone. Every
// export is generated in the browser from data the admin can already see.
// =============================================================================

import { api } from "../../assets/api.js";
import { esc, $, render, fmtDate, toastOk, toastErr, downloadCSV, plural } from "../../assets/ui.js";

const EXPORTS = [
  ["families",     "Active families",     "One row per family, with parents and contact email."],
  ["children",     "Active children",     "One row per child, with birth date and age at the semester start."],
  ["registrations","Semester registrations", "Every confirmed and waitlisted registration."],
  ["rosters",      "Class rosters",       "One row per student per class, grouped by period."],
  ["waitlists",    "Waitlists",           "Everyone waiting, in the order they joined."],
  ["schedules",    "Child schedules",     "One row per child with their class in each period."],
  ["unregistered", "Unregistered children", "Active children with no confirmed class."],
  ["full",         "Full classes",        "Classes at or over capacity, with waitlist counts."],
];

export async function show(app) {
  const semesters = await api.semesters();

  render(app, `<div class="wrap page">
    <div class="page-head"><div>
      <h1>Exports</h1>
      <div class="sub">Spreadsheet-compatible CSV. The database stays the system of record.</div>
    </div></div>

    ${semesters.length ? `<div class="field" style="max-width:320px">
      <label for="sem">Semester</label>
      <select id="sem">${semesters.map((s) =>
        `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("")}</select>
    </div>` : `<div class="note note-warn">No semesters yet — only the family and
      children exports will have anything in them.</div>`}

    <div class="grid grid-2 mt">
      ${EXPORTS.map(([key, title, desc]) => `<div class="card">
        <h3>${esc(title)}</h3>
        <p class="small muted mt" style="margin-bottom:.75rem">${esc(desc)}</p>
        <button class="btn btn-sm" data-export="${key}">Download CSV</button>
      </div>`).join("")}
    </div>
  </div>`);

  app.querySelectorAll("[data-export]").forEach((b) =>
    b.addEventListener("click", async () => {
      const semesterId = $("#sem")?.value;
      b.disabled = true;
      b.textContent = "Preparing…";
      try {
        await run(b.dataset.export, semesterId, semesters.find((s) => s.id === semesterId));
        toastOk("Downloaded.");
      } catch (e) {
        toastErr(e.message);
      } finally {
        b.disabled = false;
        b.textContent = "Download CSV";
      }
    }));
}

function ageAt(birthDate, refDate) {
  if (!birthDate || !refDate) return "";
  const b = new Date(birthDate), r = new Date(refDate);
  let age = r.getFullYear() - b.getFullYear();
  const m = r.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && r.getDate() < b.getDate())) age--;
  return age;
}

function slug(s) {
  return String(s ?? "export").replace(/\s+/g, "-").toLowerCase();
}

async function run(kind, semesterId, semester) {
  const stamp = new Date().toISOString().slice(0, 10);
  const name = (base) => `${semester ? slug(semester.name) + "-" : ""}${base}-${stamp}.csv`;
  const ref = semester?.class_start_date;

  if (kind === "families") {
    const families = await api.families();
    const rows = [["Family", "Surname", "Primary email", "Parents", "Children", "Status"]];
    for (const f of families) {
      rows.push([
        f.display_name, f.last_name ?? "", f.primary_email ?? "",
        (f.parents ?? []).map((p) => `${p.first_name} ${p.last_name ?? ""}`.trim()).join("; "),
        (f.children ?? []).filter((c) => c.active && !c.archived_at).length,
        f.active ? "Active" : "Inactive",
      ]);
    }
    return downloadCSV(`families-${stamp}.csv`, rows);
  }

  if (kind === "children") {
    const families = await api.families();
    const rows = [["Child", "Family", "Birth date", ref ? `Age on ${fmtDate(ref)}` : "Age", "Sex", "Status"]];
    for (const f of families) {
      for (const c of (f.children ?? [])) {
        if (!c.active || c.archived_at) continue;
        rows.push([
          `${c.first_name} ${c.last_name ?? ""}`.trim(), f.display_name,
          c.birth_date ?? "", ageAt(c.birth_date, ref), c.sex ?? "", "Active",
        ]);
      }
    }
    return downloadCSV(`children-${stamp}.csv`, rows);
  }

  if (!semesterId) throw new Error("Choose a semester for this export.");

  const regs = await api.semesterRegistrations(semesterId);

  if (kind === "registrations") {
    const rows = [["Student", "Family", "Family email", "Period", "Class", "Status"]];
    for (const r of regs) {
      rows.push([
        `${r.children?.first_name ?? ""} ${r.children?.last_name ?? ""}`.trim(),
        r.children?.families?.display_name ?? "",
        r.children?.families?.primary_email ?? "",
        r.classes?.periods?.display_name ?? r.classes?.periods?.period_number ?? "",
        r.classes?.name ?? "", r.status,
      ]);
    }
    return downloadCSV(name("registrations"), rows);
  }

  if (kind === "rosters") {
    const rows = [["Period", "Class", "Student", "Family", "Family email"]];
    const sorted = [...regs].filter((r) => r.status === "registered").sort((a, b) =>
      ((a.classes?.periods?.period_number ?? 0) - (b.classes?.periods?.period_number ?? 0)) ||
      (a.classes?.name ?? "").localeCompare(b.classes?.name ?? "") ||
      (a.children?.first_name ?? "").localeCompare(b.children?.first_name ?? ""));
    for (const r of sorted) {
      rows.push([
        r.classes?.periods?.display_name ?? r.classes?.periods?.period_number ?? "",
        r.classes?.name ?? "",
        `${r.children?.first_name ?? ""} ${r.children?.last_name ?? ""}`.trim(),
        r.children?.families?.display_name ?? "",
        r.children?.families?.primary_email ?? "",
      ]);
    }
    return downloadCSV(name("class-rosters"), rows);
  }

  if (kind === "waitlists") {
    const waits = regs.filter((r) => r.status === "waitlisted")
      .sort((a, b) => (a.classes?.name ?? "").localeCompare(b.classes?.name ?? "") ||
                      (a.waitlisted_at ?? "").localeCompare(b.waitlisted_at ?? ""));
    const rows = [["Class", "Position", "Student", "Family", "Family email", "Joined"]];
    let currentClass = null, pos = 0;
    for (const r of waits) {
      if (r.class_id !== currentClass) { currentClass = r.class_id; pos = 0; }
      pos++;
      rows.push([
        r.classes?.name ?? "", pos,
        `${r.children?.first_name ?? ""} ${r.children?.last_name ?? ""}`.trim(),
        r.children?.families?.display_name ?? "",
        r.children?.families?.primary_email ?? "",
        r.waitlisted_at ? new Date(r.waitlisted_at).toLocaleString() : "",
      ]);
    }
    return downloadCSV(name("waitlists"), rows);
  }

  if (kind === "schedules" || kind === "unregistered") {
    const [families, periods] = await Promise.all([
      api.families(), api.periods(semesterId),
    ]);

    if (kind === "schedules") {
      const rows = [["Student", "Family", ...periods.map((p) => p.display_name || `Period ${p.period_number}`)]];
      for (const f of families) {
        for (const c of (f.children ?? []).filter((x) => x.active && !x.archived_at)) {
          const mine = regs.filter((r) => r.children?.id === c.id && r.status === "registered");
          rows.push([
            `${c.first_name} ${c.last_name ?? ""}`.trim(), f.display_name,
            ...periods.map((p) => mine.find((r) => r.classes?.period_id === p.id)?.classes?.name ?? ""),
          ]);
        }
      }
      return downloadCSV(name("child-schedules"), rows);
    }

    const rows = [["Student", "Family", "Family email", "Classes registered"]];
    for (const f of families) {
      for (const c of (f.children ?? []).filter((x) => x.active && !x.archived_at)) {
        const n = regs.filter((r) => r.children?.id === c.id && r.status === "registered").length;
        if (n === 0) {
          rows.push([`${c.first_name} ${c.last_name ?? ""}`.trim(),
                     f.display_name, f.primary_email ?? "", 0]);
        }
      }
    }
    return downloadCSV(name("unregistered-children"), rows);
  }

  if (kind === "full") {
    const classes = await api.classes({ semester_id: semesterId });
    const rows = [["Period", "Class", "Teacher", "Enrolled", "Capacity", "Waitlisted", "Status"]];
    for (const c of classes) {
      const s = c.seats ?? {};
      if (!s.is_full && !(s.capacity != null && s.registered_count > s.capacity)) continue;
      rows.push([
        c.option_number ?? "", c.name, c.teacher_name ?? "",
        s.registered_count ?? 0, s.capacity ?? "", s.waitlisted_count ?? 0,
        s.capacity != null && s.registered_count > s.capacity ? "Over capacity" : "Full",
      ]);
    }
    if (rows.length === 1) throw new Error("No classes are full in this semester.");
    return downloadCSV(name("full-classes"), rows);
  }

  throw new Error("Unknown export.");
}
