import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { WorkItem } from '../work-item'
import { WorkFunnelStrip } from '../work-funnel-strip'

afterEach(cleanup)

const item = {
  id: 'w1',
  subject: 'Acme Corp — deal 412',
  produced: 're-entry email',
  body: 'Following up on the pricing question from our 3/14 call.',
  bodyFormat: 'markdown' as const,
  disposition: 'pending' as const,
  outcome: 'unknown' as const,
  assigneeUserId: null,
  createdAt: new Date('2026-07-20T00:00:00Z').toISOString(),
}

test('renders the subject, what was produced, and the artifact', () => {
  render(<WorkItem item={item} onPatch={() => {}} />)
  assert.ok(screen.getByText('Acme Corp — deal 412'))
  assert.ok(screen.getByText('re-entry email'))
  assert.ok(screen.getByText(/pricing question/))
})

test('Copy records used — the act IS the disposition', () => {
  const patches: unknown[] = []
  render(<WorkItem item={item} onPatch={(patch) => patches.push(patch)} />)
  fireEvent.click(screen.getByRole('button', { name: /copy/i }))
  assert.deepEqual(patches, [{ disposition: 'used' }])
})

test('Skip records skipped', () => {
  const patches: unknown[] = []
  render(<WorkItem item={item} onPatch={(patch) => patches.push(patch)} />)
  fireEvent.click(screen.getByRole('button', { name: /skip/i }))
  assert.deepEqual(patches, [{ disposition: 'skipped' }])
})

test('a dispositioned item offers no Copy or Skip', () => {
  render(<WorkItem item={{ ...item, disposition: 'used' }} onPatch={() => {}} />)
  assert.equal(screen.queryByRole('button', { name: /^skip$/i }), null)
  assert.equal(screen.queryByRole('button', { name: /^copy$/i }), null)
})

test('an unassigned item offers Claim, which assigns it to the viewer', () => {
  const patches: unknown[] = []
  render(<WorkItem item={item} onPatch={(patch) => patches.push(patch)} currentUserId="u1" />)
  fireEvent.click(screen.getByRole('button', { name: /claim/i }))
  assert.deepEqual(patches, [{ assigneeUserId: 'u1' }])
})

test('an already-assigned item offers no Claim', () => {
  render(
    <WorkItem item={{ ...item, assigneeUserId: 'u2' }} onPatch={() => {}} currentUserId="u1" />,
  )
  assert.equal(screen.queryByRole('button', { name: /claim/i }), null)
})

test('the funnel strip reports counts and rates, and says used not caused', () => {
  render(
    <WorkFunnelStrip
      stats={{
        overall: { produced: 24, used: 17, worked: 6, usedRate: 17 / 24, workedRate: 6 / 17 },
        byAgent: [
          {
            resourceId: 'a',
            resourceName: 'Signal-Based Sequence Personalizer',
            produced: 18,
            used: 14,
            worked: 6,
            usedRate: 14 / 18,
            workedRate: 6 / 14,
          },
        ],
      }}
    />,
  )
  assert.ok(screen.getByText(/24 produced/))
  assert.ok(screen.getByText(/17 used/))
  assert.ok(screen.getByText(/6 worked/))
  assert.ok(screen.getByText('Signal-Based Sequence Personalizer'))
  // These counts are descriptive, never an attribution claim.
  assert.equal(screen.queryByText(/caused/i), null)
})

test('the funnel strip renders nothing before any work exists', () => {
  const { container } = render(
    <WorkFunnelStrip
      stats={{
        overall: { produced: 0, used: 0, worked: 0, usedRate: null, workedRate: null },
        byAgent: [],
      }}
    />,
  )
  assert.equal(container.textContent, '')
})
