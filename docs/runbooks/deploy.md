# Deploy & database runbook

## How schema changes ship (the rule)

1. Change `prisma/schema.prisma` **and** add a migration in `prisma/migrations/`
   (generate with `prisma migrate diff --from-migrations prisma/migrations
   --to-schema-datamodel prisma/schema.prisma --shadow-database-url <throwaway
   pg> --script`, or `prisma migrate dev` against a local database).
2. CI (`.github/workflows/ci.yml`, `migrations` job) replays the full history
   into a fresh Postgres and fails on any drift between migrations and schema.
3. Apply to production with `npx prisma migrate deploy` using the production
   `DIRECT_URL` **on the session pooler port 5432** (the transaction pooler on
   6543 hangs Prisma DDL). Run it before or with the code deploy that needs it.

Never hand-apply SQL to production again; never `db push` at prod.

## One-time: baseline production migration history

Production predates this history (its schema was built via `db push` + curated
SQL on 2026-07-02). Mark every existing migration as already applied — this
writes `_prisma_migrations` rows without executing SQL:

```bash
npx vercel env pull .env.prod.local --environment production
# edit DIRECT_URL to port 5432 (session pooler) if still 6543
set -a; source .env.prod.local; set +a
for m in 20260609000000_den_core \
         20260628120000_mcp_connections \
         20260630120000_agent_owner \
         20260702090000_agent_chat_messages \
         20260702120000_nango_connections_integration_secrets \
         20260702160000_organization_logo \
         20260702170000_schema_catchup; do
  npx prisma migrate resolve --applied "$m"
done
rm .env.prod.local
```

After baselining, `npx prisma migrate deploy` is the only production schema
path.

### Known cosmetic prod drift (safe to leave; optional cleanup)

Production still carries legacy objects the schema no longer knows about; they
are invisible to Prisma and harmless:

- table `custom_dashboards`
- columns `integrations.accessToken/refreshToken/lastOauthRefresh/type`
- enum types `IntegrationType`, `MCPAgentType`

Optional cleanup (data loss for those legacy objects — confirm nobody needs
them): `DROP TABLE custom_dashboards; ALTER TABLE integrations DROP COLUMN ...;
DROP TYPE "IntegrationType"; DROP TYPE "MCPAgentType";`

## One-time: repo & environment protections

- **Branch protection on `main`** (GitHub → Settings → Branches): require a
  pull request and passing CI (`check`, `migrations`) before merge. This ends
  IDE auto-commits deploying production as a side effect of saving files.
- **Staging**: create a long-lived `staging` branch; in Vercel map it to a
  Preview deployment with its own Supabase project/database (set that project's
  env vars for the Preview environment of the `staging` git branch).
- **Vercel env fixes**:
  - `DIRECT_URL` → change port 6543 → **5432** (session pooler, same host).
  - `OPENAI_API_KEY` → set (default agent model is GPT-4o), or change the
    default model to a `claude-*` id via `AGENT_MODEL`.
  - `SENTRY_DSN` → set to enable error tracking (optional but recommended).
- **Worker (Phase 4)**: deploy the BullMQ worker via `render.yaml`
  (Render → New → Blueprint → this repo), setting every `sync: false` secret in
  the Render dashboard. `REDIS_URL` must be the **same Upstash TCP URL**
  (`rediss://…:6379`) Vercel uses to enqueue — NOT a separate Redis, or the
  worker listens to an empty queue. Rollout order: worker deploys green and its
  logs show the queues consuming → then flip Vercel `EXECUTION_MODE` to `queue`
  (or remove the var; prod defaults to queue) and redeploy. Until then,
  production runs inline (`EXECUTION_MODE=inline`), bounded by the 5-minute
  serverless ceiling.

## Secrets

`ENCRYPTION_KEY` is **required in production** — the server refuses to boot
without it (see `src/lib/env.ts`, enforced at startup via
`instrumentation.ts`; secrets code hard-fails too). Rotate by setting the new
key, re-saving stored connection secrets, then removing the old one.
