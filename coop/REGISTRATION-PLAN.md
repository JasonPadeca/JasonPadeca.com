# Registration: the form, and the desk it lands on

**Status: a plan. Nothing here is built.**

Registration stays a decision a person makes. This describes the paperwork that
reaches that person, and the desk they make it at — not an attempt to automate a
judgement that involves money changing hands somewhere this software cannot see.

---

## 1. What the two old forms actually ask

Both live on koinoniaphx.com today and post to WordPress.

| | New family | Returning family |
|---|---|---|
| Code of Conduct agreement | yes | yes |
| Parent name, email, phone | yes | yes |
| Home address | yes | — |
| Per child | name, date of birth, grade | name, grade |
| Child slots | 6 | 7 |
| Known absences this semester | yes | yes |
| Questions | yes | — |

**They are one form with a conditional half.** The only real difference is that
a new family is asked for its address and its children's birth dates, because
the co-op does not have them yet. Everything else is identical.

The split exists because WordPress has no idea who is filling a form in. This
system does — a family signs in. So there is no reason to publish two links, ask
anybody to work out which one applies to them, or maintain both.

### The more interesting problem

Nearly everything on the returning form is data this system **already holds**.
Parent names, emails, phones, children, birth dates — all of it is in `families`,
`parents` and `children` and has been since the first migration.

Asking a mother of seven to retype seven children's names every August, into a
form that then gets read by hand against records that already exist, is exactly
the work this project should be removing. The returning form should be a page
that shows what is on file and asks *is this still right?*

What is genuinely new each semester is small:

- the Code of Conduct agreement (a fresh act, every term, deliberately)
- each child's **grade** (changes every year; not currently stored)
- **known absences** for the coming semester
- anything they want to tell the leadership

### One thing this would fix elsewhere

Today, approving an application creates a family record with a name and an email
and nothing else, and an administrator types in the parents and children by hand.
That was the right call — "Sarah and Michael, kids are 7, 9 and 13" cannot be
split into rows without guessing.

But the new-family registration form asks for exactly those rows, from the person
who actually knows the answers. If the first registration form doubles as
"tell us about your family", the typing disappears and the guessing never happens.

---

## 2. How it goes out

A registration **window** opens per semester, the way class sign-up already does.
When Val opens it:

- every active family gets an email: *registration for Spring 2027 is open,
  sign in and complete it*
- the portal's Registration page grows a form
- the public Registration page can say it is open, since that text is already
  editable from Admin → Website

No per-family tokens. Families now sign in, and the sign-in gate already refuses
addresses the co-op does not hold. A token would be a second credential for
people who already have one.

**Order of operations.** Registration opens, families register, then class sign-up
opens — that is the co-op's actual sequence, and it is the sequence the software
should make obvious. Class sign-up currently invites every active family
regardless; that is worth revisiting once registration means something, but it is
a separate decision and needs its own answer (see §6).

---

## 3. What a family sees

One page in the portal, under Registration.

1. **Your family, as we have it.** Parents and children listed with grade boxes
   to fill in. Anything wrong gets flagged rather than edited — "tell the
   registrar" — except the fields that are theirs to give.
2. **New families** get the extra fields the co-op does not have: address, dates
   of birth, and the children themselves.
3. **Code of Conduct** — agree, with a link to it. Recorded per semester with a
   timestamp, because that is the point of asking again.
4. **Known absences** for the coming term. Long-term, these could feed the
   absence system directly; for a first pass, recorded as text and read by a
   person.
5. **Anything else you'd like us to know.**
6. Submit. The page then shows where they stand: *received, waiting to be
   reviewed*.

Payment is not mentioned beyond a line saying where it happens, because it
happens elsewhere and this software would be lying if it implied otherwise.

---

## 4. What Val sees

Admin → Registration, one block per family, which is the shape asked for:

```
┌────────────────────────────────────────────────────────┐
│ The Anderson Family                    Not started     │
│ 3 children · sarah@example.com                         │
│                                                        │
│   Form            ✓ received 2 Aug     [ Read it ]     │
│   Reviewed        ☐ not yet                            │
│   Payment         ☐ not received                       │
│                                                        │
│                              [ Register this family ]  │
└────────────────────────────────────────────────────────┘
```

Three independent facts, then one act:

- **Form** — did they send it, and when. Read-only; it is a fact, not a choice.
  The button opens what they wrote.
- **Reviewed** — a toggle. Val has read it and is happy.
- **Payment** — a toggle. Someone confirmed the money arrived, somewhere else.
- **Register this family** — the act. Sets the status she already sets by hand
  today.

### The button is never disabled

It would be easy to require all three before allowing registration. That would be
wrong for this group. A family will hand a paper form in at church; a payment will
be waived for a family having a hard year; somebody will be registered at a
meeting on a promise. A system that refuses gets worked around, and the
workaround is a spreadsheet nobody else can see.

So: register whenever you like, and if something is outstanding the block says so
plainly and the record remembers what was outstanding at the time. That is a
system that survives contact with a real co-op.

Bulk actions matter here — sixty families, most of them ordinary. *Mark all
reviewed*, or registering several at once, should exist from the start.

---

## 5. Data model sketch

Extend `semester_registrations` rather than adding a parallel table. It is already
one row per family per semester, which is exactly the grain of this.

```
semester_registrations
  status               existing: not_started | registered | not_attending
  form_submitted_at    when the family sent it
  form_data            jsonb — what they wrote, as sent
  agreed_conduct_at    the agreement, timestamped, per semester
  reviewed_at          + reviewed_by
  payment_received_at  + payment_note
  registered_at        + registered_by
  outstanding_at_registration   what was missing when the button was pressed
```

New alongside it:

```
semesters.registration_opens_at / registration_closes_at
children.grade → per-semester, so probably semester_participation.grade
                 (grade changes yearly; storing it on the child would be a
                  fact that quietly goes stale)
```

`form_data` as jsonb, not columns: this form will change, the co-op will add a
question, and a schema migration per question is a tax on a group who should be
able to ask what they like. What they wrote is kept verbatim; the structured
columns are the things the software actually acts on.

---

## 6. Open questions

These change the build, and are yours or Val's to answer:

1. **Should class sign-up be gated on registration?** Today it emails every
   active family. Options: only registered families; everyone but warn; or leave
   it. Depends whether Val would rather chase registrations first or run both at
   once.
2. **What happens to a family that never registers?** Nothing, chased by hand, or
   marked not attending automatically at some point?
3. **Grade** — is it wanted for anything beyond the roster, e.g. eligibility?
   Ages already drive class eligibility, so grade may be purely informational.
4. **Known absences** — feed the absence system, or just text for a person to
   read? The first is more work and better; the second is a week sooner.
5. **The old public forms** — retire them, or leave them up for a semester while
   people get used to signing in?

---

## 7. Roughly what it costs

| | |
|---|---|
| Migration: extend registrations, add the window, grade | small |
| Portal registration form, both variants | medium — the new-family half is the bigger piece |
| Admin blocks, toggles, bulk actions | medium |
| Emails when the window opens | small — reuses the class sign-up machinery |
| Tests | as ever |

The new-family path is the part worth building carefully, because it is the one
that removes hand-typing and the one where a mistake means a child's birth date
is wrong on a roster.
