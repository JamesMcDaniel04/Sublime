import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureWorkspaceReady } from '../workspace'

test('workspace readiness resolves after the auth context succeeds', async () => {
  let requested = ''
  await ensureWorkspaceReady(async (input) => {
    requested = input
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  })
  assert.equal(requested, '/api/auth/context')
})

test('workspace readiness surfaces the server provisioning error', async () => {
  await assert.rejects(
    ensureWorkspaceReady(async () => new Response(
      JSON.stringify({ error: 'Workspace provisioning failed' }),
      { status: 503 },
    )),
    /Workspace provisioning failed/,
  )
})
