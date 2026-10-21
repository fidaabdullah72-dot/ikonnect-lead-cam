#!/usr/bin/env bash
# Combine every migration into one file to paste into Supabase → SQL Editor
# (for a new project, when you don't use `supabase db push`).
#   deploy/supabase-schema.sh > BatSols-Supabase-Schema.sql
set -euo pipefail
cd "$(dirname "$0")/.."

cat <<'EOF'
-- =============================================================================
-- BatSols — complete database setup for a NEW Supabase project
--
-- How to use:
--   1. Supabase dashboard → your project → SQL Editor → New query
--   2. Paste this whole file and click "Run" (takes ~10 seconds)
--   3. You should see "Success. No rows returned"
--
-- Run it ONCE, on an empty project. It is one transaction: if anything fails,
-- nothing is changed and you can simply run it again after fixing the cause.
-- It also records the migrations, so later updates can be applied with
-- `supabase db push`.
-- =============================================================================

begin;

EOF
for f in supabase/migrations/*.sql; do
  echo "-- ----------------------------------------------------------------------------"
  echo "-- $(basename "$f")"
  echo "-- ----------------------------------------------------------------------------"
  cat "$f"
  echo
done
cat <<'EOF'
-- ----------------------------------------------------------------------------
-- Record the applied migrations (lets `supabase db push` add future ones)
-- ----------------------------------------------------------------------------
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text not null primary key, statements text[], name text);
insert into supabase_migrations.schema_migrations (version, name) values
EOF
ls supabase/migrations/*.sql | sed -E "s#.*/([0-9]+)_(.*)\.sql#  ('\1', '\2'),#" | sed '$ s/,$/\non conflict (version) do nothing;/'
echo
echo "commit;"
