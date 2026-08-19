/**
 * The rotation walk inside each column is shape-based, so new secret FIELDS
 * are covered automatically — but a new secret-bearing COLUMN must be added to
 * TARGETS by hand. This test derives the secret-bearing columns from
 * schema.prisma so forgetting one fails CI instead of silently skipping rows
 * at the next key rotation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROTATION_TARGETS } from '../rotate-targets'

/** Column-name shapes that hold ciphertext (or blobs that can contain it). */
const SECRET_COLUMN = /^(?:\w*Enc|authConfig|botToken|signingSecret|contentEncrypted)$/

/** Blob/text columns known to carry ciphertext (JSON blobs, or run data
 * encrypted in place — see src/lib/agents/run-crypto.ts). */
const SECRET_BLOB: Record<string, string[]> = {
  Flow: ['trigger'],
  FlowVersion: ['trigger'],
  AgentTask: ['metadata'],
  AgentExecution: ['input', 'output', 'transcript', 'plan'],
  ExecutionMessage: ['content'],
}

function lowerFirst(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1)
}

function secretColumnsFromSchema(): Array<{ model: string; column: string }> {
  const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8')
  const found: Array<{ model: string; column: string }> = []
  let model: string | null = null
  for (const line of schema.split('\n')) {
    const open = line.match(/^model\s+(\w+)\s+\{/)
    if (open) { model = open[1]; continue }
    if (line.startsWith('}')) { model = null; continue }
    if (!model) continue
    const field = line.match(/^\s{2}(\w+)\s+\S/)
    if (!field) continue
    const column = field[1]
    if (SECRET_COLUMN.test(column) || (SECRET_BLOB[model] ?? []).includes(column)) {
      found.push({ model: lowerFirst(model), column })
    }
  }
  return found
}

test('every secret-bearing column in schema.prisma is a rotation target', () => {
  const targeted = new Set(
    ROTATION_TARGETS.flatMap((t) => t.columns.map((column) => `${t.model}.${column}`)),
  )
  const missing = secretColumnsFromSchema()
    .map(({ model, column }) => `${model}.${column}`)
    .filter((key) => !targeted.has(key))
  assert.deepEqual(
    missing,
    [],
    `secret-bearing columns missing from ROTATION_TARGETS (add them in src/lib/crypto/rotate-targets.ts): ${missing.join(', ')}`,
  )
})

test('every rotation target still exists in the schema (no dead entries)', () => {
  const inSchema = new Set(secretColumnsFromSchema().map(({ model, column }) => `${model}.${column}`))
  const dead = ROTATION_TARGETS.flatMap((t) => t.columns.map((column) => `${t.model}.${column}`)).filter(
    (key) => !inSchema.has(key),
  )
  assert.deepEqual(dead, [], `rotation targets no longer in schema.prisma: ${dead.join(', ')}`)
})
