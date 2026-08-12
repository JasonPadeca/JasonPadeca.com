// =============================================================================
// The questions on a class proposal.
//
// One definition, used by the form a family fills in and by the screen an
// administrator reads it on. Two copies would drift, and the drift would show
// up as an answer filed under the wrong question — which is the sort of thing
// nobody notices until a decision has been made on it.
//
// The wording is the co-op's own, copied from the forms already on their site
// rather than shortened to suit a database column. "Will you need to use the
// church printer? If yes, how often?" is long because the people reading it
// need to know how often.
// =============================================================================

export const AGE_RANGES = [
  "Preschool", "5-9", "9-12", "12+", "Other",
];

export const HOMEWORK = ["None", "Light", "Moderate"];

export const PREP_HOUR = ["Yes", "No", "It would be nice, but not necessary"];

/** A class proposed by a parent, who intends to teach it. */
export const PARENT_FIELDS = [
  { name: "title",        label: "Title of Class", required: true },
  { name: "teacher_name", label: "Teacher", required: true },
  { name: "contact_email", label: "Email", type: "email", required: true },
  { name: "needs_helper", label: "Do you need a helper?", required: true },
  { name: "helper_details",
    label: "If so, have you already spoken to someone about being your helper, " +
           "or do you have a helper in mind?" },
  { name: "age_range", label: "Age Range for Class", type: "select",
    options: AGE_RANGES, required: true },
  { name: "description", label: "Class Description", type: "textarea", required: true },
  { name: "prerequisites", label: "Are there any prerequisites to your class?" },
  { name: "homework", label: "Will your class have homework?", type: "select",
    options: HOMEWORK, required: true },
  { name: "materials_fee",
    label: "Will there be a fee to cover the cost of class materials? If so, how much?" },
  { name: "student_materials",
    label: "Will the student need to supply any materials?" },
  { name: "size_limit",
    label: "Will there need to be a limit to the class size? Please specify if it " +
           "is a hard limit or a soft ideal." },
  { name: "technical_needs",
    label: "Please list your technical needs for this class.",
    hint: "For example: internet access, television, dvd player, laptop, bluetooth speaker." },
  { name: "own_resources",
    label: "NMC is able to supply limited internet access, televisions and dvd " +
           "players. If you have such needs, do you have the resources to supply " +
           "them yourself?" },
  { name: "printer_use",
    label: "Will you need to use the church printer? If yes, how often?",
    hint: "Weekly, once at the beginning of the semester, and so on." },
  { name: "room_request",
    label: "Is there a room at NMC that would best suit the need of this class?" },
  { name: "prep_hour", label: "Do you think you will need a prep hour before the class?",
    type: "select", options: PREP_HOUR },
  { name: "extra_info", type: "textarea",
    label: "Is there any additional information you would like us to know about your class?" },
];

/** A class proposed by a student, who would like somebody to teach it. */
export const STUDENT_FIELDS = [
  { name: "other_students",
    label: "Names of at least two other students who want to take the class." },
  { name: "parent_email", label: "Parent Email", type: "email", required: true },
  { name: "student_email", label: "Student Email", hint: "Optional." },
  { name: "title", label: "Title of Class", required: true },
  { name: "suggested_teacher", label: "Suggested Teacher", hint: "Optional." },
  { name: "age_range", label: "Age Range for Class", type: "select",
    options: AGE_RANGES, required: true },
  { name: "description", label: "Class Description", type: "textarea", required: true },
  { name: "builds_on_skills",
    label: "Does this class build on skills learned in previous classes?" },
  { name: "homework", label: "Will your class have homework?", type: "select",
    options: HOMEWORK, required: true },
  { name: "materials_needed",
    label: "What materials will be needed for this class? Be thorough." },
  { name: "technical_needs",
    label: "Please list your technical needs for this class.",
    hint: "For example: internet access, television, dvd player, laptop, bluetooth speaker." },
  { name: "room_request",
    label: "Is there a room at NMC that would best suit the need of this class?" },
  { name: "extra_info", type: "textarea",
    label: "Is there any additional information you would like us to know about your class?" },
];

export const fieldsFor = (kind) =>
  kind === "student" ? STUDENT_FIELDS : PARENT_FIELDS;

/** How a registration status should read to a human. */
export const REGISTRATION_STATUS = {
  not_started:   ["Not started",   ""],
  registered:    ["Registered",    "badge-ok"],
  not_attending: ["Not attending", ""],
};


/**
 * Who made this proposal, in words.
 *
 * The screens used to say "A student's proposal" and stop there, which tells
 * the person deciding nothing they need. Falls back to the vague form only when
 * the name is genuinely missing — a proposer whose record was later removed.
 */
export function proposerLine(p) {
  const who = p.proposer?.trim();
  const kind = p.kind === "student" ? "student" : "parent";
  if (!who) return `From a ${kind} (name no longer on file)`;
  return p.kind === "student"
    ? `${who} — a student${p.family_name ? `, ${p.family_name}` : ""}`
    : `${who}${p.family_name ? `, ${p.family_name}` : ""}`;
}
