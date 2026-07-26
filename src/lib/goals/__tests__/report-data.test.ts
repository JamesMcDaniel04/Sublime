import assert from 'node:assert/strict'
import test from 'node:test'
import { selectReportGoalRows } from '@/lib/goals/report/report-data'

const now = new Date('2026-07-26T12:00:00Z')
const cutoff = new Date('2026-04-26T12:00:00Z')
const row = (
  id: string,
  status: string,
  ownerUserId: string | null,
  updatedAt = now,
) => ({ id, status, ownerUserId, updatedAt })

test('report selection enforces viewer visibility and settled inclusion window', () => {
  const selected = selectReportGoalRows(
    [
      row('org-active', 'active', null),
      row('mine', 'paused', 'viewer'),
      row('private', 'active', 'someone-else'),
      row('recent-settled', 'achieved', null),
      row('old-settled', 'missed', null, new Date('2026-01-01T00:00:00Z')),
      row('archived', 'archived', null),
    ],
    'viewer',
    cutoff,
  )
  assert.deepEqual(selected.map((goal) => goal.id), [
    'org-active',
    'mine',
    'recent-settled',
  ])
})

test('report selection caps the document at 12 goals', () => {
  const selected = selectReportGoalRows(
    Array.from({ length: 20 }, (_, index) => row(`goal-${index}`, 'active', null)),
    'viewer',
    cutoff,
  )
  assert.equal(selected.length, 12)
})
