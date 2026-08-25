/**
 * Run-scoped secret redaction.
 *
 * Redaction has to happen at the point values are persisted, and that point
 * (`jsonValue` in execute-flow) is a plain function shared by every run. The
 * naive fix — a module-level "current secrets" set — is WRONG in the worker,
 * which runs several flow jobs concurrently in one process: whichever run
 * finished last would clear the set while another run was still writing, and
 * that run's secrets would land in the database in the clear.
 *
 * AsyncLocalStorage is the tool that actually matches the shape of the
 * problem: state scoped to an async call tree rather than to the module.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withSecretRedaction, redactForCurrentRun } from '../redaction-scope'

test('a value written inside a scope has that run\'s secrets scrubbed', async () => {
  await withSecretRedaction(['sk-live-abc123'], async () => {
    assert.equal(redactForCurrentRun('key=sk-live-abc123'), 'key=redacted')
  })
})

test('outside any scope a value passes through untouched', () => {
  assert.equal(redactForCurrentRun('key=sk-live-abc123'), 'key=sk-live-abc123')
})

test('the scope does not outlive the run', async () => {
  await withSecretRedaction(['sk-live-abc123'], async () => {})
  assert.equal(redactForCurrentRun('key=sk-live-abc123'), 'key=sk-live-abc123')
})

// The property module-level state would violate. Two runs interleave; each
// must scrub its OWN secret, and neither may stop scrubbing because the other
// finished first.
test('concurrent runs do not contaminate each other', async () => {
  const seen: string[] = []
  const slow = withSecretRedaction(['aaaaaa-secret-one'], async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    seen.push(redactForCurrentRun('one=aaaaaa-secret-one') as string)
  })
  const fast = withSecretRedaction(['bbbbbb-secret-two'], async () => {
    seen.push(redactForCurrentRun('two=bbbbbb-secret-two') as string)
  })
  await Promise.all([slow, fast])
  assert.deepEqual(seen.sort(), ['one=redacted', 'two=redacted'])
})

// A run must not scrub using another run's secrets either — that would be
// safe, but it would also mean the scoping is not real.
test('a run does not see another run\'s secrets', async () => {
  await Promise.all([
    withSecretRedaction(['aaaaaa-secret-one'], async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(redactForCurrentRun('bbbbbb-secret-two'), 'bbbbbb-secret-two')
    }),
    withSecretRedaction(['bbbbbb-secret-two'], async () => {}),
  ])
})

test('nested structures are scrubbed, not just top-level strings', async () => {
  await withSecretRedaction(['sk-live-abc123'], async () => {
    const out = redactForCurrentRun({ headers: { auth: 'Bearer sk-live-abc123' } })
    assert.doesNotMatch(JSON.stringify(out), /sk-live-abc123/)
  })
})

// An empty secret list must not cost anything, since the overwhelming majority
// of runs reference no external secret at all.
test('a run with no secrets returns the value unchanged', async () => {
  const value = { a: 1 }
  await withSecretRedaction([], async () => {
    assert.equal(redactForCurrentRun(value), value)
  })
})
