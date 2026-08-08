#!/bin/zsh
# ---------------------------------------------------------------------------
# Runs the co-op database test suite against a throwaway local Postgres.
#
# Nothing here touches Supabase or any real data — it builds a scratch cluster,
# applies the migrations from scratch, and tears down at the end. If you change
# a migration, run this before you push.
#
#   ./run-tests.sh
#
# Requires a local Postgres 15+ (Homebrew's postgresql@16 is what this was
# written against). Supabase's own pieces — the anon/authenticated/service_role
# roles and the auth.uid()/auth.jwt() helpers — are stubbed in
# 00_supabase_stub.sql so the migrations run unmodified.
# ---------------------------------------------------------------------------
set -e
cd "$(dirname "$0")"

export LC_ALL=C   # initdb refuses to start multithreaded without this on macOS
PGBIN=${PGBIN:-/opt/homebrew/opt/postgresql@16/bin}
export PATH="$PGBIN:$PATH"

# A free high port, so this never collides with a Postgres you already run.
PORT=${PORT:-$(( 55000 + RANDOM % 9000 ))}
SOCK=$(mktemp -d)
DATA=$(mktemp -d)/pgdata
MIGRATIONS=../migrations

P() { psql -h "$SOCK" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

cleanup() {
  pg_ctl -D "$DATA" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$(dirname "$DATA")" "$SOCK"
}
trap cleanup EXIT

echo "Starting scratch Postgres on port $PORT..."
initdb -D "$DATA" -A trust -U postgres >/dev/null
pg_ctl -D "$DATA" -o "-p $PORT -k $SOCK" -l "$DATA/../pg.log" start >/dev/null
sleep 2

P -d postgres -tAc "create database coop;" >/dev/null

echo "Applying migrations..."
for f in 00_supabase_stub.sql "$MIGRATIONS"/0*.sql; do
  P -d coop -f "$f" >/dev/null
done

strip() { grep -E "PASS|FAIL|ERROR" | sed 's/^psql:.*sql:[0-9]*: //; s/^NOTICE:  //; s/^WARNING:  //'; }

echo "\n=== Behavior: eligibility, registration, waitlists, overrides ==="
P -d coop -f 10_seed.sql >/dev/null
P -d coop -f 20_behavior.sql 2>&1 | strip

echo "\n=== Participation: sitting a semester out ==="
P -d postgres -tAc "drop database coop;" >/dev/null
P -d postgres -tAc "create database coop;" >/dev/null
for f in 00_supabase_stub.sql "$MIGRATIONS"/0*.sql 10_seed.sql; do
  P -d coop -f "$f" >/dev/null
done
P -d coop -f 60_participation.sql 2>&1 | strip

echo "\n=== Preferences: second choices and volunteering ==="
P -d postgres -tAc "drop database coop;" >/dev/null
P -d postgres -tAc "create database coop;" >/dev/null
for f in 00_supabase_stub.sql "$MIGRATIONS"/0*.sql 10_seed.sql; do
  P -d coop -f "$f" >/dev/null
done
P -d coop -f 70_preferences.sql 2>&1 | strip

echo "\n=== Family payload: shape, privacy, preflight ==="
P -d postgres -tAc "drop database coop;" >/dev/null
P -d postgres -tAc "create database coop;" >/dev/null
for f in 00_supabase_stub.sql "$MIGRATIONS"/0*.sql 10_seed.sql; do
  P -d coop -f "$f" >/dev/null
done
P -d coop -f 50_family_payload.sql 2>&1 | strip

echo "\n=== Authorization: RLS and privilege boundaries ==="
P -d postgres -tAc "drop database coop;" >/dev/null
P -d postgres -tAc "create database coop;" >/dev/null
for f in 00_supabase_stub.sql "$MIGRATIONS"/0*.sql 10_seed.sql; do
  P -d coop -f "$f" >/dev/null
done
P -d coop -f 40_authorization.sql 2>&1 | strip

echo "\n=== Concurrency: 40 families racing for 5 seats (§20) ==="
P -d coop -f 30_race_setup.sql >/dev/null
OUT=$(mktemp)
for i in $(seq 1 40); do
  fam=$(printf "60000000-0000-0000-0000-%012d" $i)
  kid=$(printf "70000000-0000-0000-0000-%012d" $i)
  psql -h "$SOCK" -p "$PORT" -U postgres -d coop -tAc \
    "select public.submit_family_registration('$fam','11111111-1111-1111-1111-111111111111','[{\"child_id\":\"$kid\",\"class_id\":\"3aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\"}]'::jsonb) -> 'results' -> 0 ->> 'outcome';" \
    >> "$OUT" 2>&1 &
done
wait
echo "Outcomes reported to families:"
sort "$OUT" | uniq -c
SEATED=$(P -d coop -tAc "select registered_count from public.class_seats where class_id='3aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';")
if [ "$SEATED" = "5" ]; then
  echo "PASS  exactly 5 of 40 got a seat in a 5-seat class"
else
  echo "FAIL  capacity 5 class ended up with $SEATED registrations"
fi
rm -f "$OUT"
echo "\nDone."
