import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activityTriggerConfigOf, matchActivityFlows } from '@/lib/activity/route-activity'
import type { PersistedActivity } from '@/lib/activity/ledger'

const event: PersistedActivity = {
  id: 'ev-1', organizationId: 'org-1', ingestKind: 'webhook',
  source: 'salesforce', actorRef: 'sarah', action: 'changed_stage',
  entityType: 'opportunity', entityRef: 'opp-abc',
  previousState: 'Proposal', newState: 'Qualification',
  businessContext: { accountId: 'acme' },
  occurredAt: new Date('2026-07-10T00:00:00Z'), dedupeKey: 'k',
}

test('parses a valid activity trigger config; rejects other types', () => {
  assert.deepEqual(
    activityTriggerConfigOf({ type: 'activity', sources: ['salesforce'], actions: ['changed_stage'] }),
    { type: 'activity', sources: ['salesforce'], actions: ['changed_stage'] },
  )
  assert.equal(activityTriggerConfigOf({ type: 'slack', events: ['app_mention'] }), null)
  assert.equal(activityTriggerConfigOf(null), null)
})

test('matches on source/action/entityType filters; empty filters match everything', () => {
  const flows = [
    { id: 'f-any', trigger: { type: 'activity' } },
    { id: 'f-sfdc-stage', trigger: { type: 'activity', sources: ['salesforce'], actions: ['changed_stage'] } },
    { id: 'f-github', trigger: { type: 'activity', sources: ['github'] } },
    { id: 'f-slack-trigger', trigger: { type: 'slack', events: ['app_mention'] } },
  ]
  assert.deepEqual(matchActivityFlows(event, flows).map((match) => match.id).sort(), ['f-any', 'f-sfdc-stage'])
})

test('context filter matches businessContext values by string equality', () => {
  const flows = [
    { id: 'f-acme', trigger: { type: 'activity', context: { accountId: 'acme' } } },
    { id: 'f-other', trigger: { type: 'activity', context: { accountId: 'globex' } } },
  ]
  assert.deepEqual(matchActivityFlows(event, flows).map((match) => match.id), ['f-acme'])
})
