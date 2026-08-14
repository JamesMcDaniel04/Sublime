/**
 * No table in schema `public` may be readable by `anon` or `authenticated`.
 *
 * Tenant isolation is enforced in the application layer (src/lib/tenant-guard.ts),
 * which PostgREST does not run. A grant to either role therefore exposes every
 * tenant's rows at /rest/v1/<table> to anyone holding the publishable anon key
 * — the app's own guard never sees the request.
 *
 * scripts/bootstrap-supabase-migration-test.sql deliberately arms Supabase's
 * stock `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated`
 * before migrations run, so these tests FAIL without
 * 20260813210000_lock_public_schema_grants rather than passing vacuously on a
 * plain Postgres that never had the grants to begin with.
 *
 * Verified on 2026-08-13: 71/71 tables anon-readable before the migration,
 * 0/71 after.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let rolesPresent = false

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    // has_table_privilege() raises when the role does not exist, which would
    // turn "this database was never bootstrapped" into a confusing failure
    // about grants. Detect it and skip instead.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS present FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`,
    )
    rolesPresent = rows[0].present === 2
  })

  after(async () => {
    await prisma?.$disconnect?.()
  })

  test('no public table grants SELECT to anon or authenticated', async (t) => {
    if (!rolesPresent) return t.skip('anon/authenticated absent — run scripts/bootstrap-supabase-migration-test.sql')

    const rows = await prisma.$queryRawUnsafe(`
      SELECT c.relname::text AS table_name,
             has_table_privilege('anon', c.oid, 'SELECT') AS anon_read,
             has_table_privilege('authenticated', c.oid, 'SELECT') AS auth_read
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname
    `)

    const exposed = rows
      .filter((row: any) => row.anon_read || row.auth_read)
      .map((row: any) => {
        const roles = [row.anon_read && 'anon', row.auth_read && 'authenticated'].filter(Boolean)
        return `${row.table_name} (${roles.join(', ')})`
      })

    assert.deepEqual(
      exposed,
      [],
      `Table(s) readable over PostgREST with the publishable key: ${exposed.join('; ')}. `
        + 'Tenant isolation lives in the app layer, which PostgREST bypasses. '
        + 'Revoke the grant (see prisma/migrations/20260813210000_lock_public_schema_grants).',
    )
  })

  test('a newly created table inherits no grant', async (t) => {
    if (!rolesPresent) return t.skip('anon/authenticated absent')

    // Proves the ALTER DEFAULT PRIVILEGES revoke took, not merely the one-time
    // REVOKE — the difference between fixing today's tables and fixing every
    // table the next migration adds.
    await prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS grant_drift_probe (id int)')
    try {
      const rows = await prisma.$queryRawUnsafe(`
        SELECT has_table_privilege('anon', 'public.grant_drift_probe', 'SELECT') AS anon_read,
               has_table_privilege('authenticated', 'public.grant_drift_probe', 'SELECT') AS auth_read
      `)
      assert.equal(rows[0].anon_read, false, 'a new table inherited an anon grant — default privileges are still armed')
      assert.equal(rows[0].auth_read, false, 'a new table inherited an authenticated grant — default privileges are still armed')
    } finally {
      await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS grant_drift_probe')
    }
  })

  test('Realtime channel helpers remain executable by authenticated', async (t) => {
    if (!rolesPresent) return t.skip('anon/authenticated absent')

    // The lockdown spares FUNCTIONS on purpose: can_access_run_events and
    // can_access_flow_jam authorize private Realtime channel joins. Revoking
    // them would degrade run events to polling and break flow-jam
    // collaboration, with a warning nobody reads. This is that regression guard.
    const rows = await prisma.$queryRawUnsafe(`
      SELECT has_function_privilege('authenticated', 'public.can_access_run_events(text)', 'EXECUTE') AS run_events,
             has_function_privilege('authenticated', 'public.can_access_flow_jam(text)', 'EXECUTE') AS flow_jam
    `)
    assert.equal(rows[0].run_events, true, 'run-events channel authorization lost its EXECUTE grant')
    assert.equal(rows[0].flow_jam, true, 'flow-jam channel authorization lost its EXECUTE grant')
  })
}
