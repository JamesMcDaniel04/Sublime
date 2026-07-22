/**
 * Scoped sessionStorage persistence for opt-in URLs. The in-memory cache dies
 * on a full-page navigation (an OAuth redirect), which made the integrations
 * page paint "all disconnected" until /api/nango/status returned. Persisted
 * entries survive the redirect within the same tab, are validated against the
 * signed-in scope before painting, and are purged on sign-out or user switch.
 */
import '@/test-support/jsdom-env'
import { test, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, act, waitFor } from '@testing-library/react'
import { useCachedJson, scopeCachedJson, __testResetForReload } from '../use-cached-json'

afterEach(() => cleanup())
beforeEach(() => {
  scopeCachedJson(null)
  window.sessionStorage.clear()
  __testResetForReload()
})

function deferredFetch() {
  const pending: Array<{ resolve: (body: unknown) => void }> = []
  globalThis.fetch = (() =>
    new Promise((resolve) => {
      pending.push({
        resolve: (body: unknown) => resolve({ ok: true, status: 200, json: async () => body } as Response),
      })
    })) as typeof fetch
  return pending
}

function mountHook(url: string, persist = true) {
  const state: { current?: ReturnType<typeof useCachedJson<{ value?: string }>> } = {}
  function Probe() {
    state.current = useCachedJson<{ value?: string }>(url, persist ? { persist: true } : undefined)
    return null
  }
  render(React.createElement(Probe))
  return state
}

async function seedPersistedValue(url: string, scope: string, body: unknown) {
  const pending = deferredFetch()
  act(() => scopeCachedJson(scope))
  const state = mountHook(url)
  await waitFor(() => assert.equal(pending.length, 1))
  await act(async () => pending[0].resolve(body))
  await waitFor(() => assert.deepEqual(state.current?.data, body))
  cleanup()
}

test('a persisted entry survives a simulated hard reload for the same user', async () => {
  await seedPersistedValue('/api/test/persist-reload', 'user-1', { value: 'connected-snapshot' })

  // Hard reload: module memory resets, sessionStorage survives.
  __testResetForReload()
  const pending = deferredFetch()
  act(() => scopeCachedJson('user-1'))
  const state = mountHook('/api/test/persist-reload')

  // Instant paint from the persisted snapshot — before any fetch resolves.
  assert.deepEqual(state.current?.data, { value: 'connected-snapshot' })
  assert.equal(state.current?.loading, false)

  // Still revalidates in the background.
  await waitFor(() => assert.equal(pending.length, 1))
  await act(async () => pending[0].resolve({ value: 'fresh' }))
  await waitFor(() => assert.deepEqual(state.current?.data, { value: 'fresh' }))
})

test('a hook mounted before sign-in settles repaints when hydration lands', async () => {
  await seedPersistedValue('/api/test/persist-late-scope', 'user-1', { value: 'snapshot' })

  __testResetForReload()
  deferredFetch()
  // Mount FIRST (hard page load: components mount before the sidebar scopes the cache).
  const state = mountHook('/api/test/persist-late-scope')
  assert.equal(state.current?.data, undefined)

  // Sign-in settles → hydration → the mounted hook repaints without a fetch.
  act(() => scopeCachedJson('user-1'))
  await waitFor(() => assert.deepEqual(state.current?.data, { value: 'snapshot' }))
})

test('a different signed-in user never sees the persisted snapshot, which is purged', async () => {
  await seedPersistedValue('/api/test/persist-other-user', 'user-1', { value: 'secret' })

  __testResetForReload()
  deferredFetch()
  act(() => scopeCachedJson('user-2'))
  const state = mountHook('/api/test/persist-other-user')
  assert.equal(state.current?.data, undefined)
  // And the other user's blob is gone from storage entirely.
  assert.equal(window.sessionStorage.length, 0)
})

test('sign-out purges persisted entries', async () => {
  await seedPersistedValue('/api/test/persist-signout', 'user-1', { value: 'secret' })
  assert.ok(window.sessionStorage.length > 0, 'entry persisted while signed in')
  act(() => scopeCachedJson(null))
  assert.equal(window.sessionStorage.length, 0)
})

test('non-persist URLs are never written to sessionStorage', async () => {
  const pending = deferredFetch()
  act(() => scopeCachedJson('user-1'))
  const state = mountHook('/api/test/no-persist', false)
  await waitFor(() => assert.equal(pending.length, 1))
  await act(async () => pending[0].resolve({ value: 'memory-only' }))
  await waitFor(() => assert.deepEqual(state.current?.data, { value: 'memory-only' }))
  assert.equal(window.sessionStorage.length, 0)
})
