import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { WorkRulesStrip } from '../work-rules-strip'

afterEach(cleanup)

const rule = {
  id: 'rul_8f2',
  statement: 'Do not work subjects whose daysCold is under 14.',
  signal: 'daysCold',
  skippedCount: 6,
  totalCount: 7,
  topSkipReason: 'too_early',
  exploreRate: 0.2,
  learnedAt: '2026-07-20T00:00:00.000Z',
  scope: 'agent' as const,
  agentName: 'Signal-Based Sequence Personalizer',
}

test('renders nothing when no rule is in force', () => {
  const { container } = render(<WorkRulesStrip rules={[]} onRevoke={() => {}} />)
  assert.equal(container.textContent, '')
})

test('shows the inference and the evidence behind it', () => {
  // A rule that changes what agents produce has to be legible, or the system
  // is steering from conclusions nobody can inspect.
  render(<WorkRulesStrip rules={[rule]} onRevoke={() => {}} />)
  assert.ok(screen.getByText('Do not work subjects whose daysCold is under 14.'))
  assert.ok(screen.getByText(/6 of 7 skipped/))
  assert.ok(screen.getByText(/too early/))
  assert.ok(screen.getByText(/Signal-Based Sequence Personalizer/))
})

test('never shows a raw enum reason', () => {
  render(<WorkRulesStrip rules={[rule]} onRevoke={() => {}} />)
  assert.equal(screen.queryByText(/too_early/), null)
})

test('an org-wide rule is marked as such', () => {
  render(
    <WorkRulesStrip
      rules={[{ ...rule, scope: 'org', agentName: null }]}
      onRevoke={() => {}}
    />,
  )
  assert.ok(screen.getByText('Org-wide'))
})

test('an agent-scoped rule carries no org badge', () => {
  render(<WorkRulesStrip rules={[rule]} onRevoke={() => {}} />)
  assert.equal(screen.queryByText('Org-wide'), null)
})

test('Turn off reports the rule to revoke', () => {
  const revoked: string[] = []
  render(<WorkRulesStrip rules={[rule]} onRevoke={(id) => revoked.push(id)} />)
  fireEvent.click(screen.getByRole('button', { name: /turn off/i }))
  assert.deepEqual(revoked, ['rul_8f2'])
})
