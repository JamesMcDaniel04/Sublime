-- Revoke PostgREST's reach into Prisma-owned tables.
--
-- Supabase ships `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON
-- TABLES TO anon, authenticated`, scoped to the granting role. `prisma migrate
-- deploy` connects as that same role, so every table this repo has ever
-- created may carry a grant to `anon` — readable over PostgREST at
-- /rest/v1/<table> with the publishable key, with no RLS to stop it.
--
-- Tenant isolation in this app is enforced in the application layer (see
-- src/lib/tenant-guard.ts), which PostgREST does not run. The run-events
-- migration already asserted "Prisma-owned tables are not exposed to the
-- authenticated role" — this migration is what finally makes that true rather
-- than assumed, and public-schema-grants.pg.test.ts is what keeps it true.
--
-- This cannot affect the application: Prisma connects as the table OWNER, and
-- ownership is not mediated by these grants.
--
-- Deliberately NOT revoked:
--   * FUNCTIONS. public.can_access_run_events / can_access_flow_jam are granted
--     to `authenticated` on purpose (private Realtime channel authorization).
--     A blanket function revoke would silently break run-event delivery and
--     flow-jam collaboration, degrading both to polling with no error.
--   * Schema USAGE. Those same helper functions live in `public` and need it.
--
-- Not a substitute for RLS, which remains the structural fix once the app
-- connects as a non-owner role — see docs/runbooks/verify-postgrest-exposure.md.
DO $lockdown$
DECLARE
  target_role text;
BEGIN
  FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
      RAISE NOTICE 'role % absent (plain Postgres) — nothing to revoke', target_role;
      CONTINUE;
    END IF;

    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', target_role);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', target_role);

    -- Future tables. Default privileges are per-granting-role, so revoking for
    -- the current role is what stops the NEXT migration from re-arming the
    -- grant. Without this the fix lasts exactly until someone adds a model.
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', target_role);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', target_role);

    -- And for `postgres` when the migration runs as somebody else: a deploy
    -- role that is not postgres would otherwise leave the postgres-role
    -- defaults armed for any table created through the dashboard or psql.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres')
       AND current_user <> 'postgres' THEN
      BEGIN
        EXECUTE format(
          'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM %I', target_role);
        EXECUTE format(
          'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', target_role);
      EXCEPTION
        WHEN insufficient_privilege THEN
          RAISE WARNING 'cannot alter postgres-role default privileges for %; re-run as postgres to complete', target_role;
      END;
    END IF;
  END LOOP;
END
$lockdown$;
