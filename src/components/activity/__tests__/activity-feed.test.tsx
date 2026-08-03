/**
 * The activity ledger pages by cursor, not by page count, so the two states
 * worth pinning are "more history exists" (a Load more affordance) and
 * "that was everything" (a terminal count, never a dead button).
 *
 * `fetch` is stubbed per test — the same approach as first-run-guide.test.tsx.
 */
import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen, waitFor } from '@testing-library/react'
import { ActivityFeed, type ActivityEvent } from '../activity-feed'

afterEach(cleanup)

const event = (id: string): ActivityEvent => ({
  id,
  source: 'github',
  actorName: 'Ada',
  action: 'merged',
  entityType: 'pull_request',
  entityName: 'Add the ledger',
  outcome: 'success',
  occurredAt: new Date('2026-08-01T10:00:00Z').toISOString(),
  ingestKind: 'backfill',
})

function mockPage(body: { events: ActivityEvent[]; nextCursor: string | null }) {
  globalThis.fetch = (async () =>
    ({ ok: true, status: 200, json: async () => ({ success: true, ...body }) }) as Response) as typeof fetch
}

test('events render with their source, actor, and how they were captured', async () => {
  mockPage({ events: [event('a')], nextCursor: null })
  render(<ActivityFeed sources={['github']} />)
  await waitFor(() => assert.ok(screen.getByText('Ada')))
  assert.ok(screen.getAllByText('GitHub').length > 0)
  assert.ok(screen.getByText('merged'))
  // 'backfill' is an internal ingest kind; the row says what it means.
  assert.ok(screen.getByText('History'))
})

test('a cursor offers more history rather than a page count', async () => {
  mockPage({ events: [event('a')], nextCursor: 'a' })
  render(<ActivityFeed sources={['github']} />)
  await waitFor(() => assert.ok(screen.getByRole('button', { name: /load more/i })))
})

test('the last page ends rather than offering a dead button', async () => {
  mockPage({ events: [event('a')], nextCursor: null })
  render(<ActivityFeed sources={['github']} />)
  await waitFor(() => assert.ok(screen.getByText(/end of history/i)))
  assert.equal(screen.queryByRole('button', { name: /load more/i }), null)
})

test('an empty ledger points at the import that would fill it', async () => {
  mockPage({ events: [], nextCursor: null })
  render(<ActivityFeed sources={['github']} />)
  await waitFor(() => assert.ok(screen.getByText(/no activity yet/i)))
})
