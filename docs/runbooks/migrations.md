# Database migrations — safety runbook

Migrations run during the **Vercel build** (`scripts/vercel-migrate.mjs` →
`prisma migrate deploy`), which means the schema changes **minutes before the
new code is promoted** — and the Render worker never runs migrations at all.
That ordering has three sharp edges; this runbook is how to not cut yourself.

## The expand/contract rule (non-negotiable)

Because old code serves traffic against the new schema during every deploy
window, a migration must always be **additive first**:

- **Safe in one deploy:** adding a nullable column, adding a table, adding an
  index (see below), widening a type, adding an enum VALUE (append only).
- **Never in one deploy:** renaming a column/enum value, dropping a column,
  adding a NOT NULL column without a default, tightening a constraint.

Real incident class: `ALTER TYPE "UserRole" RENAME VALUE 'USER' TO 'MEMBER'`
(20260729120000) — the moment it committed, the still-live old code writing
`role: 'USER'` failed every signup with `invalid input value for enum` until
promotion finished. The correct shape is expand → deploy code that writes the
new value → contract in a later deploy once no old code remains.

Contract steps (drops/renames) go in their own migration, merged only after
the expand deploy is fully rolled out **and the worker has been redeployed**
(see below).

## Indexes on large tables

`CREATE INDEX` takes a write lock for the build. On `agent_executions` /
`activity_events`-sized tables prefer:

```sql
CREATE INDEX CONCURRENTLY "name" ON "table"("col");
```

`CONCURRENTLY` cannot run inside a transaction — put it in its own migration
file and add `-- prisma migrate: no transaction` semantics by keeping it the
only statement (Prisma runs each migration in a transaction by default; for a
truly hot table, apply concurrently by hand via `psql` and mark the migration
applied with `prisma migrate resolve --applied <name>`).

## The worker is not migrated by the web deploy

The Render worker's build is `npm ci && npm run db:generate` — **generate
only**. A Vercel deploy migrates the shared database while the worker keeps
running the previous release's Prisma client. For additive migrations that's
fine (the old client ignores new columns). For anything else:

1. Merge the expand migration + web code.
2. Wait for Vercel promotion.
3. **Manually redeploy the worker** (Render dashboard → Deploy latest) so its
   client matches.
4. Only then merge any contract migration.

## Concurrent builds / failed half-applied migrations

Prisma takes an advisory lock during `migrate deploy`, so two racing builds
serialize; the loser can fail on lock timeout — rerunning the build is safe.

A migration that fails **partway** is recorded as failed in
`_prisma_migrations` and blocks every subsequent deploy. Recovery:

```bash
# See what's stuck
npx prisma migrate status

# If the migration's effects were NOT applied (or you rolled them back by hand):
npx prisma migrate resolve --rolled-back <migration_name>

# If you completed its statements manually and the schema now matches:
npx prisma migrate resolve --applied <migration_name>
```

Run against production with `DATABASE_URL`/`DIRECT_URL` exported from the
Vercel env (`migrate deploy`/`resolve` use `directUrl`). There is no automatic
rollback — Postgres DDL that half-applied must be reconciled by hand first.

## QA database

The persistent QA Postgres does NOT get migrations automatically. Before
trusting QA test failures after a schema change, run
`npx prisma migrate deploy` against the QA `DATABASE_URL` first.
