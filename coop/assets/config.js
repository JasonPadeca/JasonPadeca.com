// =============================================================================
// Connection settings.
//
// FILL THESE IN after creating your Supabase project — see coop/SETUP.md step 2.
//
// Both values below are meant to be public. The anon key is a browser key: it
// identifies the project, it does not grant access. Every table has Row Level
// Security on and no policy grants anything to an anonymous caller, so a person
// holding this key and nothing else can read exactly nothing. Real access comes
// either from a Google sign-in matched against the `admins` table, or from a
// family's invitation token, and both are checked server-side on every request.
//
// What must NEVER appear in this file, or anywhere else under coop/:
//   the service_role key, the database password, the mail account password,
//   the Google OAuth client secret.
// Those live only in Supabase's secret storage.
// =============================================================================

export const SUPABASE_URL = "https://ydmybkpojqpzvlqkpcah.supabase.co";

// Supabase's newer key format. `sb_publishable_…` is the browser-safe key and
// is the direct replacement for the legacy `anon` JWT — it maps to the same
// `anon` Postgres role the policies in 0002_authorization.sql are written
// against. Its counterpart, `sb_secret_…`, must never appear in this file.
export const SUPABASE_ANON_KEY = "sb_publishable_LVsa3ZDs_Oy75SU-Q-L6lA_4JkwfNxc";

export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

export const IS_CONFIGURED =
  !SUPABASE_URL.includes("YOUR-PROJECT-REF") &&
  !SUPABASE_ANON_KEY.includes("YOUR-ANON-KEY");
