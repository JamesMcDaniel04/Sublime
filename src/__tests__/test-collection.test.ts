/**
 * Every test file must actually be collectable.
 *
 * `npm test` hands file paths to `node --test`, which reads its arguments as
 * GLOBS. A path segment like `[id]` — which App Router dynamic routes use
 * everywhere — is a character class, so `api/flows/[id]/migrate/__tests__/`
 * matches nothing and the tests inside it are silently never run.
 *
 * Silently. The suite stays green, the coverage gates stay satisfied, and the
 * tests contribute nothing. This guard exists because that failure announces
 * itself in no other way.
 *
 * A test for a dynamic route belongs in a bracket-free __tests__ directory and
 * imports the route by its real path.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

test('no test file lives under a bracketed path segment', () => {
  const found = execFileSync('find', [
    'src', '-type', 'f',
    '(', '-name', '*.test.ts', '-o', '-name', '*.test.tsx', ')',
    '-path', '*[[]*[]]*',
  ], { encoding: 'utf8' }).trim()

  assert.equal(
    found,
    '',
    `These test files sit under a dynamic-route directory and will never be collected:\n${found}\n` +
    'Move them to a bracket-free __tests__ directory and import the route by path.',
  )
})
