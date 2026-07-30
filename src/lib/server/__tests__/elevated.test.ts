import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { ELEVATED_ACTIONS } from '../elevated'

const SRC_DIR = fileURLToPath(new URL('../../..', import.meta.url))

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

const productionSources = walk(SRC_DIR)
  .filter((file) => !file.endsWith('elevated.ts'))
  .map((file) => readFileSync(file, 'utf8'))

/**
 * The elevated vocabulary is a CONTRACT, not a wish list.
 *
 * Three actions — member.role.change, member.deactivate, admin.resource.delete
 * — sat in this union with no production call site. Two of them could never
 * have had one: withElevatedAccess checks resource:takeover, while changing a
 * role or suspending someone is member:manage, so recording them through it
 * would have asserted the wrong capability. An unused entry reads like a
 * promise the log keeps, and this one did not.
 */
test('every elevated action is actually recorded somewhere in production code', () => {
  const unused = ELEVATED_ACTIONS.filter(
    (action) => !productionSources.some((source) => source.includes(`'${action}'`)),
  )
  assert.deepEqual(
    unused,
    [],
    `Elevated action(s) with no call site: ${unused.join(', ')}. `
      + 'Either record them where the act happens, or drop them — the union should describe what the audit log '
      + 'genuinely contains.',
  )
})

test('the vocabulary covers only acts withElevatedAccess can legitimately gate', () => {
  // withElevatedAccess hardcodes the resource:takeover check, so every action
  // in this union must BE a cross-owner resource act. Member administration is
  // member:manage and is audited directly by its own route.
  for (const action of ELEVATED_ACTIONS) {
    assert.match(
      action,
      /^admin\.resource\./,
      `${action} is not a cross-owner resource act, so withElevatedAccess would gate it on the wrong capability`,
    )
  }
})
