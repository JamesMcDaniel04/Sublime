/**
 * The Granola key panel's whole job is to expose a secret it can never read
 * back, so these cover the two states that distinguish it from a normal form:
 * a saved org key (replaceable + removable, never rendered) and the deployment
 * env fallback (configured, but nothing of this workspace's to remove).
 *
 * `fetch` is stubbed per test — the same approach as first-run-guide.test.tsx.
 */
import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen, waitFor } from '@testing-library/react'
import { GranolaKeyPanel } from '../granola-key-panel'

afterEach(cleanup)

function mockState(state: { configured: boolean; source: 'org' | 'env' | null }) {
  globalThis.fetch = (async () =>
    ({ ok: true, status: 200, json: async () => ({ success: true, ...state }) }) as Response) as typeof fetch
}

test('a saved workspace key reads as connected and offers removal', async () => {
  mockState({ configured: true, source: 'org' })
  render(<GranolaKeyPanel isAdmin />)
  await waitFor(() => assert.ok(screen.getByText(/connected/i)))
  assert.ok(screen.getByRole('button', { name: /remove key/i }))
  // The key is encrypted and never returned, so nothing may present itself as
  // the stored value — the field must be empty and the action a replacement.
  const field = screen.getByLabelText(/replace the saved key/i) as HTMLInputElement
  assert.equal(field.value, '')
  assert.equal(field.type, 'password')
})

test('the deployment env fallback is configured but has nothing to remove', async () => {
  mockState({ configured: true, source: 'env' })
  render(<GranolaKeyPanel isAdmin />)
  await waitFor(() => assert.ok(screen.getByText(/deployment key/i)))
  assert.equal(screen.queryByRole('button', { name: /remove key/i }), null)
})

test('an unconfigured workspace is offered a connect form', async () => {
  mockState({ configured: false, source: null })
  render(<GranolaKeyPanel isAdmin />)
  await waitFor(() => assert.ok(screen.getByText(/not connected/i)))
  assert.ok(screen.getByRole('button', { name: /^connect$/i }))
})

test('a member sees the state but no key form', async () => {
  mockState({ configured: true, source: 'org' })
  render(<GranolaKeyPanel isAdmin={false} />)
  await waitFor(() => assert.ok(screen.getByText(/only workspace admins/i)))
  assert.equal(screen.queryByLabelText(/replace the saved key/i), null)
})
