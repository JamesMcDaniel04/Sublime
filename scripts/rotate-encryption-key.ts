/**
 * ENCRYPTION_KEY rotation and plaintext-exposure report.
 *
 * Before this existed, rotating ENCRYPTION_KEY bricked every stored secret:
 * `v2:`/`v1:` payloads are AES-256-GCM under a key derived from that env var, and
 * nothing could re-encrypt them. "Rotate the keys" — the first thing anyone
 * does after a credential incident — was therefore not a supported operation.
 *
 * Usage:
 *   # What is stored, and how much of it is only base64-obscured?
 *   npx tsx scripts/rotate-encryption-key.ts --report
 *
 *   # Dry run: decrypt under the old key, re-encrypt under the new, write nothing.
 *   OLD_ENCRYPTION_KEY=<old> ENCRYPTION_KEY=<new> npx tsx scripts/rotate-encryption-key.ts
 *
 *   # Same, but persist.
 *   OLD_ENCRYPTION_KEY=<old> ENCRYPTION_KEY=<new> npx tsx scripts/rotate-encryption-key.ts --apply
 *
 * Rotation is re-runnable and never overwrites a value it cannot decrypt, so
 * an interrupted run is resumed by running it again. Deploy order: run with
 * --apply while the app still holds the OLD key (rotated rows keep working
 * only after the new key is live), so take a maintenance window or accept a
 * brief window of credential failures — this is a deliberate operation, not a
 * background migration.
 */
import { PrismaClient } from '../src/generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { countCiphertextsDeep, rotateCiphertextsDeep } from '../src/lib/crypto/rotate'

/**
 * Every column that can hold a ciphertext. Listing the COLUMNS is unavoidable
 * (they are physical), but the walk inside each is shape-based, so a new
 * secret FIELD within one of these blobs is covered automatically.
 */
const TARGETS: Array<{ model: string; columns: string[] }> = [
  { model: 'credential', columns: ['authConfig'] },
  { model: 'mcpConnection', columns: ['authConfig'] },
  { model: 'postgresConnection', columns: ['authConfig'] },
  { model: 'integrationSecret', columns: ['authConfig'] },
  { model: 'googleOAuthConnection', columns: ['refreshTokenEnc'] },
  { model: 'slackWorkspaceConnection', columns: ['botToken', 'signingSecret'] },
  { model: 'knowledgeDocument', columns: ['contentEncrypted'] },
  { model: 'knowledgeChunk', columns: ['contentEncrypted'] },
  // Webhook trigger secrets ride inside the trigger/metadata blobs.
  { model: 'flow', columns: ['trigger'] },
  { model: 'flowVersion', columns: ['trigger'] },
  // Agent webhook trigger secrets live in AgentTask.metadata.triggerSecretEnc.
  { model: 'agentTask', columns: ['metadata'] },
]

const BATCH = 200

// The rotation script deliberately bypasses the tenant-guarded client: it is
// an operator tool that must sweep EVERY workspace, which the guard exists to
// prevent application code from doing.
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL }),
})

type Totals = { rows: number; rotated: number; upgraded: number; failed: number }

async function report(): Promise<void> {
  console.log('Stored-secret report (v2/v1 = encrypted, b64 = reversible base64, NOT encryption)\n')
  let totalB64 = 0

  for (const target of TARGETS) {
    const delegate = (prisma as unknown as Record<string, any>)[target.model]
    if (!delegate) {
      console.log(`  ${target.model.padEnd(26)} SKIPPED (no such model)`)
      continue
    }
    const counts = { v2: 0, v1: 0, b64: 0 }
    let cursor: string | undefined
    for (;;) {
      const rows = await delegate.findMany({
        take: BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
        select: Object.fromEntries([['id', true], ...target.columns.map((column) => [column, true])]),
      })
      if (!rows.length) break
      for (const row of rows) {
        for (const column of target.columns) {
          const found = countCiphertextsDeep(row[column])
          counts.v2 += found.v2
          counts.v1 += found.v1
          counts.b64 += found.b64
        }
      }
      cursor = rows[rows.length - 1].id
      if (rows.length < BATCH) break
    }
    totalB64 += counts.b64
    const flag = counts.b64 > 0 ? '  ⚠ REVERSIBLE' : ''
    // v2 must appear here. Reporting only v1 would print "v1=0 b64=0" for a
    // fully-rotated table, which reads as "no secrets stored" rather than
    // "every secret is on the current derivation".
    console.log(
      `  ${target.model.padEnd(26)} v2=${String(counts.v2).padEnd(6)} v1=${String(counts.v1).padEnd(6)} b64=${String(counts.b64).padEnd(6)}${flag}`,
    )
  }

  console.log(
    totalB64 > 0
      ? `\n${totalB64} value(s) are stored as reversible base64, readable by anyone with database access.\n`
        + 'These were written while ENCRYPTION_KEY was unset. Run a rotation to promote them to AES-256-GCM.'
      : '\nNo reversible-base64 values found.',
  )
}

async function rotate(oldKey: string, newKey: string, apply: boolean): Promise<void> {
  console.log(apply ? 'ROTATING (writes enabled)\n' : 'DRY RUN — no writes. Pass --apply to persist.\n')
  const grand: Totals = { rows: 0, rotated: 0, upgraded: 0, failed: 0 }

  for (const target of TARGETS) {
    const delegate = (prisma as unknown as Record<string, any>)[target.model]
    if (!delegate) continue
    const totals: Totals = { rows: 0, rotated: 0, upgraded: 0, failed: 0 }
    let cursor: string | undefined

    for (;;) {
      const rows = await delegate.findMany({
        take: BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
        select: Object.fromEntries([['id', true], ...target.columns.map((column) => [column, true])]),
      })
      if (!rows.length) break

      for (const row of rows) {
        const data: Record<string, unknown> = {}
        let touched = false
        for (const column of target.columns) {
          const result = rotateCiphertextsDeep(row[column], oldKey, newKey)
          totals.rotated += result.rotated
          totals.upgraded += result.upgraded
          totals.failed += result.failed
          if (result.rotated || result.upgraded) {
            data[column] = result.value
            touched = true
          }
          if (result.failed) {
            console.warn(`  ! ${target.model}.${column} id=${row.id}: ${result.failed} value(s) opened under neither key — left untouched`)
          }
        }
        if (touched) {
          totals.rows += 1
          if (apply) await delegate.update({ where: { id: row.id }, data })
        }
      }

      cursor = rows[rows.length - 1].id
      if (rows.length < BATCH) break
    }

    if (totals.rotated || totals.upgraded || totals.failed) {
      console.log(
        `  ${target.model.padEnd(26)} rows=${totals.rows} rotated=${totals.rotated} upgraded=${totals.upgraded} failed=${totals.failed}`,
      )
    }
    grand.rows += totals.rows
    grand.rotated += totals.rotated
    grand.upgraded += totals.upgraded
    grand.failed += totals.failed
  }

  console.log(`\nTotal: rows=${grand.rows} rotated=${grand.rotated} upgraded=${grand.upgraded} failed=${grand.failed}`)
  if (grand.failed > 0) {
    console.error('\nSome values opened under neither key. They were NOT modified — investigate before switching the live key.')
    process.exitCode = 1
  }
  if (!apply && (grand.rotated || grand.upgraded)) console.log('Re-run with --apply to persist.')
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2))

  if (args.has('--report')) {
    await report()
    return
  }

  const oldKey = process.env.OLD_ENCRYPTION_KEY
  const newKey = process.env.ENCRYPTION_KEY
  if (!oldKey || !newKey) {
    console.error('Set OLD_ENCRYPTION_KEY and ENCRYPTION_KEY (or pass --report).')
    process.exitCode = 2
    return
  }
  if (oldKey === newKey) {
    console.error('OLD_ENCRYPTION_KEY and ENCRYPTION_KEY are identical — nothing to rotate.')
    process.exitCode = 2
    return
  }

  await rotate(oldKey, newKey, args.has('--apply'))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
