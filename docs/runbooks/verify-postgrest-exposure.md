# Verifying PostgREST table exposure

**Why this exists:** tenant isolation in this app is enforced in the application
layer — `src/lib/tenant-guard.ts` throws when an org-scoped Prisma query omits
`organizationId`. PostgREST does not run that guard. It reads Postgres directly,
authorized only by table grants and RLS. So a grant to `anon` or `authenticated`
on a Prisma-owned table exposes every tenant's rows to anyone holding the
publishable key, no matter how correct the application code is.

Supabase ships `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO
anon, authenticated`, scoped to the granting role — the same role
`prisma migrate deploy` connects as. Migration
`20260813210000_lock_public_schema_grants` revokes those grants and disarms the
defaults; `src/lib/__tests__/public-schema-grants.pg.test.ts` keeps them
revoked. This runbook is how you confirm it on a live project.

## 1. Audit the grants (read-only, safe on production)

Run in the Supabase SQL editor, or via `psql "$DIRECT_URL"`:

```sql
SELECT c.relname AS table_name,
       c.relrowsecurity AS rls_enabled,
       has_table_privilege('anon', c.oid, 'SELECT') AS anon_read,
       has_table_privilege('authenticated', c.oid, 'SELECT') AS auth_read
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY anon_read DESC, auth_read DESC, c.relname;
```

**Expected after the migration:** `anon_read` and `auth_read` are `false` for
every row. `rls_enabled` will be `false` for the application tables — that is
expected and is not the finding (see "Why RLS is not the fix here" below).

**If any row shows `anon_read = true`:** that table is live-readable with the
publishable key. Apply the migration (`npx prisma migrate deploy`) and re-run.

Also confirm the defaults are disarmed, so the next migration does not re-arm
them:

```sql
SELECT defaclrole::regrole AS granting_role,
       defaclobjtype AS object_type,
       defaclacl AS default_privileges
FROM pg_default_acl d
JOIN pg_namespace n ON n.oid = d.defaclnamespace
WHERE n.nspname = 'public';
```

**Expected:** no entry granting to `anon` or `authenticated`.

## 2. Confirm from outside (the check that actually matters)

The grant query proves the database's intent. This proves what the internet
sees. Run with the project's **publishable/anon** key — never the service role
key:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/users?select=id&limit=1" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY"
```

**Expected:** `401` or `403`. A `200` with a JSON array is a live cross-tenant
data leak — treat it as an incident, apply the migration immediately, and rotate
anything the exposed rows contained.

Worth repeating for the highest-value tables: `users`, `organizations`,
`credentials`, `integration_secrets`, `mcp_connections`, `audit_events`.

## 3. Re-run the automated guard

```bash
TEST_DATABASE_URL=<throwaway-postgres-url> \
TSX_TSCONFIG_PATH=tsconfig.test.json \
npx tsx --test src/lib/__tests__/public-schema-grants.pg.test.ts
```

This runs in CI on every push. It fails loudly if a future migration re-exposes
a table, and it is armed by `scripts/bootstrap-supabase-migration-test.sql`,
which reproduces Supabase's stock default privileges so the test cannot pass
vacuously.

## Why RLS is not the fix here

Enabling row-level security on the application tables would change nothing
today. **Postgres exempts a table's owner from RLS** unless the table is set to
`FORCE ROW LEVEL SECURITY`, and Prisma connects as the owner. Turning RLS on
would satisfy a checklist while leaving behaviour identical — and if the deploy
role ever stopped being the owner, it would take the whole application down
instead.

RLS becomes the structural fix only as part of a larger change:

1. Create a dedicated non-owner application role and grant it explicit
   table privileges.
2. Point `DATABASE_URL` at that role.
3. Set a per-request tenant context (`SET LOCAL app.organization_id`) on every
   connection — non-trivial with PgBouncer transaction pooling, which is what
   `DATABASE_URL` uses in production.
4. Write a policy per org-scoped table and a test per policy.
5. Enable RLS, then delete the application-layer guard it replaces.

Until then the grant revoke is the control that matters: it removes the only
path that bypasses the application guard. `src/lib/tenant-guard.ts` documents
its own limitations (an `organizationId` anywhere in the `where` tree satisfies
it, including inside an `OR`; `$queryRaw` is unguarded) and those remain the
argument for eventually doing the work above.
