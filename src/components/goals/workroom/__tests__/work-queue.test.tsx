import '@/test-support/jsdom-env'
import { test, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react'
import { WorkQueue } from '../work-queue'

afterEach(cleanup)

const emptyStats = {
  overall: { produced: 0, used: 0, worked: 0, usedRate: null, workedRate: null },
  byAgent: [],
  byAssignee: [],
}

const respond = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as Response

const item = (overrides: Record<string, unknown> = {}) => ({
  id: 'w1',
  subject: 'Acme — deal 412',
  produced: 're-entry email',
  body: 'hello',
  bodyFormat: 'markdown',
  disposition: 'pending',
  outcome: 'unknown',
  assigneeUserId: null,
  createdAt: '2026-07-20T00:00:00.000Z',
  ...overrides,
})

beforeEach(() => {
  globalThis.fetch = (async () => respond({ items: [], stats: emptyStats })) as typeof fetch
})

test('an empty queue explains itself and points at the agent bundle', async () => {
  render(<WorkQueue goalId="g1" />)
  await waitFor(() => {
    assert.ok(screen.getByText(/no work yet/i))
    assert.ok(screen.getByText(/deploy an agent below/i))
  })
})

test('items render with their subject', async () => {
  globalThis.fetch = (async () =>
    respond({ items: [item()], stats: emptyStats })) as typeof fetch

  render(<WorkQueue goalId="g1" />)
  await waitFor(() => assert.ok(screen.getByText('Acme — deal 412')))
})

test('switching a filter tab refetches with that filter', async () => {
  const urls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    return respond({ items: [], stats: emptyStats })
  }) as typeof fetch

  render(<WorkQueue goalId="g1" />)
  await waitFor(() => assert.ok(urls.some((url) => url.includes('filter=mine'))))
  fireEvent.click(screen.getByRole('tab', { name: 'Unassigned' }))
  await waitFor(() => assert.ok(urls.some((url) => url.includes('filter=unassigned'))))
})

test('the outcome prompt asks only about used work older than a week', async () => {
  const old = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString()
  const fresh = new Date().toISOString()
  globalThis.fetch = (async () =>
    respond({
      items: [
        item({ id: 'old', subject: 'Old one', disposition: 'used', createdAt: old }),
        item({ id: 'new', subject: 'Fresh one', disposition: 'used', createdAt: fresh }),
        item({ id: 'skip', subject: 'Skipped one', disposition: 'skipped', createdAt: old }),
      ],
      stats: emptyStats,
    })) as typeof fetch

  render(<WorkQueue goalId="g1" />)
  await waitFor(() => assert.ok(screen.getByText(/did these land/i)))

  const prompt = screen.getByText(/did these land/i).parentElement!
  assert.ok(prompt.textContent?.includes('Old one'), 'aged used work is asked about')
  assert.equal(
    prompt.textContent?.includes('Fresh one'),
    false,
    'fresh work has not had time to land',
  )
  assert.equal(
    prompt.textContent?.includes('Skipped one'),
    false,
    'skipped work was never sent, so it has no outcome to report',
  )
})

test('a failed load renders an empty queue rather than breaking the goal page', async () => {
  globalThis.fetch = (async () => {
    throw new Error('offline')
  }) as typeof fetch

  render(<WorkQueue goalId="g1" />)
  await waitFor(() => assert.ok(screen.getByText(/no work yet/i)))
})

test('Claim appears once the viewer id arrives with the queue', async () => {
  globalThis.fetch = (async () =>
    respond({ items: [item()], stats: emptyStats, viewerId: 'u-viewer' })) as typeof fetch

  render(<WorkQueue goalId="g1" />)
  await waitFor(() => assert.ok(screen.getByRole('button', { name: /claim/i })))
})

test('without a viewer id there is no Claim to click', async () => {
  globalThis.fetch = (async () =>
    respond({ items: [item()], stats: emptyStats })) as typeof fetch

  render(<WorkQueue goalId="g1" />)
  await waitFor(() => assert.ok(screen.getByText('Acme — deal 412')))
  assert.equal(screen.queryByRole('button', { name: /claim/i }), null)
})

const withRep = (viewerHasWork: boolean) => ({
  items: [item()],
  stats: {
    overall: { produced: 4, used: 3, worked: 1, usedRate: 0.75, workedRate: 0.33 },
    byAgent: [],
    byAssignee: [
      {
        assigneeUserId: 'u1',
        assigneeName: 'Dana Reed',
        produced: 4,
        used: 3,
        worked: 1,
        usedRate: 0.75,
        workedRate: 0.33,
      },
    ],
  },
  viewerHasWork,
})

test('a viewer with no assigned work sees adoption before the queue', async () => {
  globalThis.fetch = (async () => respond(withRep(false))) as typeof fetch
  const { container } = render(<WorkQueue goalId="g1" />)
  await waitFor(() => assert.ok(screen.getByText('Dana Reed')))
  const text = container.textContent ?? ''
  assert.ok(
    text.indexOf('Dana Reed') < text.indexOf('Acme — deal 412'),
    'the process owner sees the team before the queue',
  )
})

test('a viewer with assigned work sees their queue first', async () => {
  globalThis.fetch = (async () => respond(withRep(true))) as typeof fetch
  const { container } = render(<WorkQueue goalId="g1" />)
  await waitFor(() => assert.ok(screen.getByText('Acme — deal 412')))
  const text = container.textContent ?? ''
  assert.ok(
    text.indexOf('Acme — deal 412') < text.indexOf('Dana Reed'),
    'a rep sees their work first',
  )
  assert.ok(screen.getByText('Dana Reed'), 'but adoption still renders below')
})
