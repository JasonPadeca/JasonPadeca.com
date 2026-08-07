# Setup

Everything in `coop/` is written and tested. What remains is connecting it to
accounts, which needs your hands — creating accounts and entering passwords is
yours to do.

Budget about 30 minutes. Nothing here is reversible in a way that matters; if a
step goes wrong you can redo it.

You will create two free accounts (Supabase and Brevo), run one SQL file, and
paste four values into two places.

---

## Before you start

Have these ready:

- The Google account that will be the **owner** of the co-op admin system —
  yours, presumably.
- The email addresses of the other administrators (you can add these later).
- A domain you can add DNS records to, if you want email to come from your own
  address rather than a shared one. Optional; see step 6.

---

## 1. Create the Supabase project

1. Go to <https://supabase.com> and sign up (GitHub sign-in is fine).
2. **New project**.
   - **Name:** anything — `homeschool-coop`.
   - **Database password:** let it generate one, and save it in your password
     manager. You will almost never need it, and you cannot retrieve it later.
   - **Region:** whichever is closest to your families.
   - **Plan:** Free.
3. Wait for it to finish provisioning (a minute or two).

---

## 2. Run the database migrations

In the Supabase dashboard, open **SQL Editor** › **New query**.

Run these four files **in order**, one at a time. Paste the whole contents of
each, press **Run**, and wait for "Success" before starting the next:

1. `coop/supabase/migrations/0001_core_schema.sql`
2. `coop/supabase/migrations/0002_authorization.sql`
3. `coop/supabase/migrations/0003_enrollment.sql`
4. `coop/supabase/migrations/0004_family_payload.sql`

Order matters — each one builds on the last.

Then make yourself the owner. Run this with **your** Google address:

```sql
insert into public.admins (email, display_name, role)
values ('you@gmail.com', 'Your Name', 'owner');
```

This is the only row you ever need to insert by hand. Every other
administrator can be added from the Settings page once you are in.

---

## 3. Put the project keys in the site

In Supabase: **Project Settings** › **API**. You need two values:

- **Project URL** — looks like `https://abcdefghijklm.supabase.co`
- **anon public** key — a long string starting `eyJ...`

Open `coop/assets/config.js` and replace the two placeholders:

```js
export const SUPABASE_URL = "https://abcdefghijklm.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOi...";
```

Both are meant to be public — the anon key identifies the project, it does not
grant access. Every table has Row Level Security on and no policy grants an
anonymous caller anything.

**Never put the `service_role` key here.** That one bypasses all security. It
belongs only in Supabase's own secret storage (step 5).

---

## 4. Turn on Google sign-in

**In Google Cloud Console** (<https://console.cloud.google.com>):

1. Create a project, or reuse one.
2. **APIs & Services** › **OAuth consent screen**. External. Fill in the app
   name and your email. You do not need to submit it for verification —
   while it is in "Testing", add each administrator's Google address under
   **Test users**. (Or publish it; with only a sign-in scope, publishing is
   not subject to review.)
3. **Credentials** › **Create credentials** › **OAuth client ID** › **Web application**.
4. Under **Authorised redirect URIs**, add exactly:

   ```
   https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback
   ```

5. Copy the **Client ID** and **Client secret**.

**In Supabase:** **Authentication** › **Sign In / Providers** › **Google**.
Enable it, paste the Client ID and Client secret, and save.

Then **Authentication** › **URL Configuration**:

- **Site URL:** `https://jasonpadeca.com/coop/admin/`
- **Redirect URLs:** add `https://jasonpadeca.com/coop/admin/**`

---

## 5. Deploy the Edge Functions

The four functions in `coop/supabase/functions/` handle everything that needs a
secret: validating family invitation links, committing registrations, and
sending email.

Install the Supabase CLI (this Mac does not have it yet):

```bash
brew install supabase/tap/supabase
```

Then, from the repository root:

```bash
supabase login
```

```bash
supabase link --project-ref YOUR-PROJECT-REF
```

```bash
supabase functions deploy --project-ref YOUR-PROJECT-REF --workdir coop/supabase
```

If you would rather not install the CLI, you can paste each function's code
into **Edge Functions** › **Deploy a new function** in the dashboard instead —
but the CLI handles the shared `_shared/` files for you, so it is the easier path.

### Function secrets

**Project Settings** › **Edge Functions** › **Secrets**. Add:

| Name | Value |
|---|---|
| `BREVO_API_KEY` | from step 6 |
| `ALLOWED_ORIGINS` | `https://jasonpadeca.com` |
| `KEEPALIVE_SECRET` | any long random string you invent — used in step 7 |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically; you
do not add those.

---

## 6. Set up email

1. Sign up at <https://www.brevo.com> (the free tier is 300 emails/day, which is
   far more than a co-op of this size sends).
2. **Senders, Domains & Dedicated IPs**:
   - Simplest: add a **sender** — a single address like
     `registration@yourcoop.org` — and click the verification link Brevo emails
     to it. You must be able to receive mail at that address.
   - Better: verify the whole **domain** by adding Brevo's DNS records. Mail is
     much less likely to land in spam.
3. **SMTP & API** › **API Keys** › **Generate a new API key**. Copy it into the
   `BREVO_API_KEY` secret from step 5.

Then in the co-op admin site, **Settings** › **Program** › **Edit**:

| Field | Value |
|---|---|
| Registration link address | `https://jasonpadeca.com/coop/register/` |
| Sending address | the address you verified with Brevo |
| Sender name | e.g. `Maple Grove Co-op` |
| Reply-to address | your normal co-op inbox, so replies reach a human |
| Time zone | e.g. `America/Chicago` |

**The registration link address must be exactly right.** It is what every
family's personalised link is built from; if it is wrong, every invitation
email points somewhere broken.

---

## 7. Turn on the keepalive

Free Supabase projects pause after a stretch of inactivity, and a paused project
means a family clicking their link gets an error. `.github/workflows/coop-keepalive.yml`
pings it every six hours.

On GitHub: **Settings** › **Secrets and variables** › **Actions** › **New repository secret**.

| Name | Value |
|---|---|
| `COOP_KEEPALIVE_URL` | `https://YOUR-PROJECT-REF.supabase.co/functions/v1/keepalive` |
| `COOP_KEEPALIVE_SECRET` | the same string you used for `KEEPALIVE_SECRET` |

Then **Actions** › **Co-op keepalive** › **Run workflow** to check it works. The
Settings page in the admin site will show the time of the last successful ping.

---

## 8. Commit and push

```bash
git add coop .github/workflows/coop-keepalive.yml && git commit -m "Add homeschool co-op registration system"
```

```bash
git push
```

GitHub Pages will publish within a minute or two. Then visit
<https://jasonpadeca.com/coop/admin/> and sign in with the Google account you
made the owner in step 2.

---

## First run

1. **Settings** — add the other administrators by their Google addresses.
2. **Families** — add each family, its parents, and its children. Birth dates
   matter: age eligibility is calculated from them.
3. **Semesters** — create the semester, set its **first class date** (ages are
   calculated as of that day), add the periods, then the classes.
4. **Open Registration** — the preflight check will tell you about missing
   emails, teacherless classes, and children without birth dates before anything
   is sent. Every active family then gets their own link by email.

Send yourself a test first: add a family with your own email address, open
registration, and click your own link. It is much easier to fix a wrong sending
address before forty families have it.

---

## Running the database tests

If you ever change a migration, verify it before pushing:

```bash
cd coop/supabase/tests && ./run-tests.sh
```

It builds a scratch Postgres, applies the migrations from nothing, and runs 105
checks covering eligibility, capacity, waitlists, overrides, RLS boundaries, and
a 40-way concurrent race for 5 seats. It never touches your Supabase project.

Needs a local Postgres 15+ (`brew install postgresql@16`).

---

## Backups (§32)

Supabase's free tier keeps daily backups, but take your own before anything
significant — opening registration, or a big roster change:

**Database** › **Backups** › **Download**, or from the CLI:

```bash
supabase db dump --project-ref YOUR-PROJECT-REF -f coop-backup-$(date +%F).sql
```

Keep those somewhere off Supabase. They contain children's names and birth
dates, so treat them accordingly — not a shared drive, not email.

---

## If something goes wrong

**"You do not have access to this administration system."**
You signed in with a Google account that is not an active row in `admins`. Check
the address matches exactly, and that `active` is true.

**Nobody receives invitation emails.**
Check the sending address in Settings is the one verified with Brevo, and that
`BREVO_API_KEY` is set as a function secret. The semester page shows a specific
error against each family whose email failed.

**Families see "This link is not valid."**
Usually the registration link address in Settings is wrong or was changed after
invitations went out. Fix it, then use **Resend** on the semester page.

**The admin page hangs on "Loading…".**
Usually the Supabase project has paused. Open the Supabase dashboard to wake it,
then check the keepalive workflow in step 7 is actually running.
