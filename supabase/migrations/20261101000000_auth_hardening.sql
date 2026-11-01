-- Phase 6C: lock the public schema down to the server's own Postgres role.
--
-- The API connects with a privileged role that bypasses RLS, so authorization is enforced in the Express server,
-- not here. What this migration guarantees is that the anon and authenticated roles, which anyone holding the public
-- anon key can use through Supabase's Data API, cannot read or change Recall's data at all.

-- Created by `pnpm db:migrate` itself, so it missed the RLS added in the first migration. Without RLS, the Data API
-- could insert rows here and make the migrator skip real migrations.
alter table if exists schema_migrations enable row level security;

-- Belt and braces on top of RLS-with-no-policies: revoke the default Supabase grants. Skipped on a plain Postgres
-- where these roles do not exist.
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke all on functions from %I', r);
    end if;
  end loop;
end $$;
