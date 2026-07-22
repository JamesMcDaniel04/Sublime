/**
 * The stale-while-revalidate cache's behavior across auth-scope changes.
 * The critical invariant: a scope change that lands while a fetch is
 * in-flight (sign-in settling on a hard page load — e.g. returning from an
 * OAuth redirect) must NOT strand the hook with `loading: false` and no
 * data. That exact race painted the integrations page as "No integrations
 * are enabled yet" after every successful connect.
 */
import '@/test-support/jsdom-env'
import { test, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, act, waitFor } from '@testing-library/react'
import { useCachedJson, scopeCachedJson } from '../use-cached-json'

afterEach(() => cleanup())
beforeEach(() => scopeCachedJson(null))

type Deferred = { resolve: (body: unknown) => void }

/** Install a fetch mock whose responses resolve only when the test says so. */
function deferredFetch() {
  const pending: Deferred[] = []
  globalThis.fetch = (() =>
    new Promise((resolve) => {
      pending.push({
        resolve: (body: unknown) =>
          resolve({ ok: true, status: 200, json: async () => body } as Response),
      })
    })) as typeof fetch
  return pending
}

function mountHook(url: string) {
  const state: { current?: ReturnType<typeof useCachedJson<{ value?: string }>> } = {}
  function Probe() {
    state.current = useCachedJson<{ value?: string }>(url)
    return null
  }
  render(React.createElement(Probe))
  return state
}

test('a scope change mid-flight refetches instead of stranding the hook empty', async () => {
  const pending = deferredFetch()
  const state = mountHook('/api/test/scope-race')

  await waitFor(() => assert.equal(pending.length, 1, 'initial fetch started'))

  // Sign-in settles while the fetch is in flight (sidebar calls this).
  act(() => scopeCachedJson('user-1'))

  // The pre-scope response arrives — it must not be painted, but it must
  // trigger a refetch under the new scope rather than giving up.
  await act(async () => pending[0].resolve({ value: 'stale-scope' }))

  await waitFor(() => assert.equal(pending.length, 2, 'refetched under the new scope'))
  await act(async () => pending[1].resolve({ value: 'fresh' }))

  await waitFor(() => {
    assert.equal(state.current?.loading, false)
    assert.deepEqual(state.current?.data, { value: 'fresh' }, 'data lands despite the mid-flight scope change')
  })
})

test('refresh resolves with the fetched payload so callers can poll on it', async () => {
  const pending = deferredFetch()
  const state = mountHook('/api/test/refresh-returns')

  await waitFor(() => assert.equal(pending.length, 1))
  await act(async () => pending[0].resolve({ value: 'first' }))
  await waitFor(() => assert.equal(state.current?.loading, false))

  let returned: { value?: string } | undefined
  await act(async () => {
    const promise = state.current!.refresh()
    await waitFor(() => assert.equal(pending.length, 2))
    pending[1].resolve({ value: 'second' })
    returned = await promise
  })
  assert.deepEqual(returned, { value: 'second' }, 'refresh returns the payload it fetched')
})
