/**
 * Component tests for the three dashboard onboarding states the goal-based
 * repositioning spec (§6) calls for: first-run (nothing done), no-goals-with-
 * connections (partial progress), and goals-present (guide complete/hidden).
 *
 * FirstRunGuide owns the connect/goal/deploy step derivation end to end —
 * `goalsCount` is passed in (the dashboard already resolves it from
 * `/api/goals` via `activeGoals`), while connections and agents are fetched
 * internally via `getCachedJson`/`getSnapshot`. Both of those hit `fetch`
 * under the hood, so this mocks `fetch` per test rather than fetching real
 * data — the same approach as `use-cached-json.test.tsx`.
 */
import '@/test-support/jsdom-env'
import { test, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen, waitFor, act } from '@testing-library/react'
import { __testResetForReload } from '@/lib/client/use-cached-json'
import { __testResetSnapshotForReload } from '@/lib/client/snapshot'
import { FirstRunGuide } from '../first-run-guide'

type Snapshot = {
  success: boolean
  agents: unknown[]
  activities: unknown[]
  usage: { since: string; executions: number; inputTokens: number; outputTokens: number }
  activeOrganizationId: string | null
  organizations: unknown[]
  notifications: unknown[]
  unread: number
}

function mockFetch(options: { connections?: Record<string, { connected: boolean }>; agents?: unknown[] }) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/api/nango/status') {
      return { ok: true, status: 200, json: async () => ({ connections: options.connections ?? {} }) } as Response
    }
    if (url === '/api/snapshot') {
      const body: Snapshot = {
        success: true,
        agents: options.agents ?? [],
        activities: [],
        usage: { since: new Date().toISOString(), executions: 0, inputTokens: 0, outputTokens: 0 },
        activeOrganizationId: null,
        organizations: [],
        notifications: [],
        unread: 0,
      }
      return { ok: true, status: 200, json: async () => body } as Response
    }
    throw new Error(`Unexpected fetch in test: ${url}`)
  }) as typeof fetch
}

beforeEach(() => {
  __testResetForReload()
  __testResetSnapshotForReload()
})
afterEach(() => cleanup())

test('first-run state: nothing connected, no goal, no agent — all three steps open', async () => {
  mockFetch({ connections: {}, agents: [] })
  render(React.createElement(FirstRunGuide, { goalsCount: 0 }))

  await waitFor(() => assert.ok(screen.queryByText('Connect your stack')))
  assert.ok(screen.getByText('Plug in the tools your team already uses'))
  assert.ok(screen.getByText('What are you trying to achieve? Quota, ARR, a launch date?'))
  assert.ok(screen.getByText('Sublime proposes agents once a goal exists'))
})

test('no-goals-with-connections state: connected but no goal yet — connect step done, goal step open', async () => {
  mockFetch({ connections: { slack: { connected: true }, gmail: { connected: true } }, agents: [] })
  render(React.createElement(FirstRunGuide, { goalsCount: 0 }))

  await waitFor(() => assert.ok(screen.queryByText(/2 connected/)))
  assert.ok(screen.getByText('What are you trying to achieve? Quota, ARR, a launch date?'), 'goal step still open')
  assert.ok(screen.getByText('Sublime proposes agents once a goal exists'), 'deploy step still open')
})

test('goals-present state: connections, a goal (even personal-only), and an agent all exist — guide hides', async () => {
  mockFetch({ connections: { slack: { connected: true } }, agents: [{ id: 'a1' }] })
  // goalsCount=1 here stands for the dashboard passing activeGoals(goals).length
  // — any active goal, personal or org, must be enough to complete this step.
  const { container } = render(React.createElement(FirstRunGuide, { goalsCount: 1 }))

  // Give the internal connections/agents fetches (and their state updates)
  // time to resolve and reconcile before asserting the guide stayed hidden —
  // a fixed-string assertion can't "wait for absence" the way waitFor waits
  // for presence, so this flushes real time instead of racing.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  assert.equal(container.textContent, '', 'guide stays hidden once every step is complete')
  assert.equal(screen.queryByText('Connect. Connect the dots. Deploy. Prove it.'), null)
})
