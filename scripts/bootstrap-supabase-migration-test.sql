-- Minimal Supabase database surface used only by migration tests running on
-- ordinary PostgreSQL. Production Supabase projects already own these roles,
-- schemas, tables, and functions; this file must never be run against them.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$roles$;

-- Supabase's STOCK default privileges, reproduced deliberately.
--
-- A real project ships `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON
-- TABLES TO anon, authenticated`, scoped to the granting role — which is the
-- same role `prisma migrate deploy` connects as. Every table this repo creates
-- therefore inherits a PostgREST-readable grant unless something revokes it.
--
-- Without these three lines, public-schema-grants.pg.test.ts would pass
-- vacuously on a plain Postgres (no grants to find) and the guard would prove
-- nothing. Arming the hazard here is what makes the test meaningful: it fails
-- without the lockdown migration and passes with it.
GRANT USAGE ON SCHEMA public TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;

CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULL::uuid;
$$;

CREATE SCHEMA IF NOT EXISTS realtime;

CREATE TABLE IF NOT EXISTS realtime.messages (
  extension text NOT NULL DEFAULT 'broadcast'
);

CREATE OR REPLACE FUNCTION realtime.topic()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT ''::text;
$$;
