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

test('Skip asks why before recording anything', () => {
  // "Skipped" alone says something is wrong; the reason says what to change.
  const patches: unknown[] = []
  render(<WorkItem item={item} onPatch={(patch) => patches.push(patch)} />)
  fireEvent.click(screen.getByRole('button', { name: /^skip$/i }))
  assert.deepEqual(patches, [], 'the first click only opens the reasons')
  assert.ok(screen.getByRole('button', { name: /too early/i }))
})

test('choosing a reason records it with the skip', () => {
  const patches: unknown[] = []
  render(<WorkItem item={item} onPatch={(patch) => patches.push(patch)} />)
  fireEvent.click(screen.getByRole('button', { name: /^skip$/i }))
  fireEvent.click(screen.getByRole('button', { name: /too early/i }))
  assert.deepEqual(patches, [{ disposition: 'skipped', skipReason: 'too_early' }])
})

test('every vocabulary reason is offered', () => {
  render(<WorkItem item={item} onPatch={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: /^skip$/i }))
  for (const label of [/too early/i, /wrong contact/i, /wrong content/i, /already handled/i, /not relevant/i, /other/i]) {
    assert.ok(screen.getByRole('button', { name: label }), `${label} must be offered`)
  }
})

test('the reason picker can be dismissed without skipping', () => {
  const patches: unknown[] = []
  render(<WorkItem item={item} onPatch={(patch) => patches.push(patch)} />)
  fireEvent.click(screen.getByRole('button', { name: /^skip$/i }))
  fireEvent.click(screen.getByRole('button', { name: /never mind/i }))
  assert.deepEqual(patches, [])
  assert.ok(screen.getByRole('button', { name: /^copy$/i }), 'the normal actions come back')
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
        byAssignee: [],
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
        byAssignee: [],
      }}
    />,
  )
  assert.equal(container.textContent, '')
})

test('"Other" asks what was wrong instead of recording a bare enum', () => {
  // `other` is exactly where the five fixed reasons failed, so recording only
  // the string "other" throws away the one case worth reading.
  const patches: unknown[] = []
  render(<WorkItem item={item} onPatch={(patch) => patches.push(patch)} />)
  fireEvent.click(screen.getByRole('button', { name: /^skip$/i }))
  fireEvent.click(screen.getByRole('button', { name: /^other$/i }))
  assert.deepEqual(patches, [], 'choosing Other records nothing yet')
  assert.ok(screen.getByLabelText(/what was wrong/i))
})

test('the note is recorded alongside the other reason', () => {
  const patches: unknown[] = []
  render(<WorkItem item={item} onPatch={(patch) => patches.push(patch)} />)
  fireEvent.click(screen.getByRole('button', { name: /^skip$/i }))
  fireEvent.click(screen.getByRole('button', { name: /^other$/i }))
  fireEvent.change(screen.getByLabelText(/what was wrong/i), {
    target: { value: 'The account merged last week.' },
  })
  fireEvent.click(screen.getByRole('button', { name: /skip it/i }))
  assert.deepEqual(patches, [
    { disposition: 'skipped', skipReason: 'other', skipNote: 'The account merged last week.' },
  ])
})

test('an empty note still skips, recording null rather than an empty string', () => {
  const patches: unknown[] = []
  render(<WorkItem item={item} onPatch={(patch) => patches.push(patch)} />)
  fireEvent.click(screen.getByRole('button', { name: /^skip$/i }))
  fireEvent.click(screen.getByRole('button', { name: /^other$/i }))
  fireEvent.click(screen.getByRole('button', { name: /skip it/i }))
  assert.deepEqual(patches, [{ disposition: 'skipped', skipReason: 'other', skipNote: null }])
})

test('the five fixed reasons still record in one tap', () => {
  const patches: unknown[] = []
  render(<WorkItem item={item} onPatch={(patch) => patches.push(patch)} />)
  fireEvent.click(screen.getByRole('button', { name: /^skip$/i }))
  fireEvent.click(screen.getByRole('button', { name: /already handled/i }))
  assert.deepEqual(patches, [{ disposition: 'skipped', skipReason: 'already_handled' }])
})
