/**
 * A migration must not be able to take production down while it waits.
 *
 * On 2026-08-25 the api_keys migration hung for two minutes and failed. The
 * failure was the visible part; the damage was not. `ALTER TABLE … ADD FOREIGN
 * KEY` takes SHARE ROW EXCLUSIVE on the PARENT table, and `users` is written on
 * every authenticated request. With no bound, the ALTER did not just wait — it
 * QUEUED, and a queued lock request blocks every write behind it. The deploy
 * degraded production for as long as it hung.
 *
 * `lock_timeout` is what turns that into a fast, harmless failure. This gate
 * makes the next migration that takes a heavy lock declare one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = new URL('../../../../prisma/migrations', import.meta.url).pathname

/**
 * The rule applies from the incident onward, not retroactively.
 *
 * Dozens of earlier migrations add foreign keys without a bound. They are all
 * long since applied, and editing an applied migration changes its checksum —
 * which makes Prisma refuse the next deploy. So they are history rather than
 * debt, and a curated exemption list of that size would rot immediately.
 *
 * A timestamp cutoff needs no maintenance and cannot be silently widened: a
 * new migration is always newer than this, so it is always checked.
 */
const RULE_APPLIES_FROM = '20260825040000'

/** DDL that takes a lock heavy enough to block writes on a busy table. */
const HEAVY_DDL = /ALTER TABLE[\s\S]*?ADD CONSTRAINT[\s\S]*?FOREIGN KEY/i

test('a migration that adds a foreign key bounds its lock wait', () => {
  const offenders: string[] = []

  for (const name of readdirSync(MIGRATIONS, { withFileTypes: true })) {
    if (!name.isDirectory() || name.name < RULE_APPLIES_FROM) continue
    let sql: string
    try {
      sql = readFileSync(join(MIGRATIONS, name.name, 'migration.sql'), 'utf8')
    } catch {
      continue
    }
    if (HEAVY_DDL.test(sql) && !/lock_timeout/i.test(sql)) offenders.push(name.name)
  }

  assert.deepEqual(
    offenders,
    [],
    'These migrations add a foreign key without SET LOCAL lock_timeout. ' +
    'An ALTER waiting on a lock blocks every write queued behind it, so an ' +
    'unbounded wait takes production down rather than merely failing:\n' +
    offenders.join('\n'),
  )
})

// The cutoff only means anything if migrations actually sort by it — a naming
// change would silently switch the gate off for everything.
test('migration names sort chronologically, so the cutoff holds', () => {
  const names = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  assert.ok(names.length > 0, 'no migrations found — the gate would pass vacuously')
  assert.ok(
    names.every((name) => /^\d{14}_/.test(name)),
    'a migration is not timestamp-prefixed; the cutoff can no longer be trusted',
  )
  assert.ok(names.some((name) => name >= RULE_APPLIES_FROM), 'the cutoff excludes every migration')
})
