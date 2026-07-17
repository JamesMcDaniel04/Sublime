---
name: verify
description: How to verify Sublime changes end-to-end without cloud credentials — throwaway Postgres + the route-smoke protocol (real route handlers, seeded auth).
---

# Verifying Sublime changes

No `.env` exists locally; Supabase/Neo4j/Voyage/Anthropic credentials live in Vercel/Render. The repo's evidence protocol is **route-handler drives against a real local Postgres**, not booting `next dev` (page auth needs Supabase).

## Throwaway Postgres (Homebrew PG15 has pgvector)

```bash
export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"
QA=<scratch-dir>/qa-pg
initdb -D "$QA/data" -U qa --no-locale -E UTF8
# Unix socket path length limit (103 bytes) — go TCP-only:
pg_ctl -D "$QA/data" -o "-p 54339 -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" -l "$QA/pg.log" start
createdb -h 127.0.0.1 -p 54339 -U qa sublime_qa
```

Migrations reference Supabase-only objects. Stub them BEFORE `migrate deploy`:

```sql
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid';
CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
CREATE SCHEMA IF NOT EXISTS realtime;
CREATE TABLE IF NOT EXISTS realtime.messages (id bigint, topic text, extension text);
CREATE OR REPLACE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS 'SELECT NULL::text';
```

Then: `DATABASE_URL=postgresql://qa@127.0.0.1:54339/sublime_qa DIRECT_URL=$DATABASE_URL npx prisma migrate deploy`

## Driving real surfaces

- **Authenticated API routes:** follow `src/app/api/__tests__/route-smoke.test.ts` / `behavior-e2e.test.ts` — set `TEST_DATABASE_URL`, seed with `seedTestOrg` + `installTestAuth` (`src/lib/server/__tests__/test-auth.ts`), import the route module, call its `GET/POST` with a `NextRequest`. The test-auth seam is double-gated (non-prod + `TEST_DATABASE_URL`), production-inert.
- **Cron surfaces:** set `CRON_SECRET`, call the route with `authorization: Bearer <secret>`.
- Run: `TEST_DATABASE_URL=postgresql://qa@127.0.0.1:54339/sublime_qa TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <file>`
- Queries in YOUR assertions must include `organizationId` — the tenant guard (`src/lib/tenant-guard.ts`) throws on unscoped org-model queries through the guarded `prisma` client.

## Gotchas

- `docker info` hangs (no daemon) — don't probe Docker; `supabase start` unavailable.
- LLM-dependent legs (agent runs, copilot/assistant replies, suggestion synthesis) fail gracefully without keys — assert the degradation, not the output. Async `void`-fired cron work: poll the DB, don't trust the response alone.
- `npm run build` needs `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` (placeholders fine) or auth-page prerender fails; the vercel-migrate step needs `DATABASE_URL`.
- Cleanup: `pg_ctl -D "$QA/data" stop`.
