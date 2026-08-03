-- Minimal Supabase database surface used only by migration tests running on
-- ordinary PostgreSQL. Production Supabase projects already own these roles,
-- schemas, tables, and functions; this file must never be run against them.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$roles$;

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
