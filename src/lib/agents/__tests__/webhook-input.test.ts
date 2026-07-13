import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentWebhookEventName, agentWebhookInput } from '@/lib/agents/webhook-input'

test('string webhook input is passed directly to the instructed agent', () => {
  assert.equal(agentWebhookInput({ input: 'A critical deal changed stage' }, 'Run the playbook'), 'A critical deal changed stage')
})

test('structured webhook input is preserved as JSON event context', () => {
  assert.deepEqual(
    JSON.parse(agentWebhookInput({ input: { event: 'deal.changed', account: 'Acme', amount: 50000 } }, 'fallback')),
    { event: 'deal.changed', account: 'Acme', amount: 50000 },
  )
})

test('a raw external event body becomes the run input when input is omitted', () => {
  assert.deepEqual(
    JSON.parse(agentWebhookInput({ type: 'ticket.escalated', ticketId: 'T-9' }, 'fallback')),
    { type: 'ticket.escalated', ticketId: 'T-9' },
  )
})

test('empty payload falls back to the agent objective', () => {
  assert.equal(agentWebhookInput({}, 'Run the configured external-event playbook'), 'Run the configured external-event playbook')
})

test('event provenance comes from the header, then event/type fields', () => {
  assert.equal(agentWebhookEventName({ event: 'body.event' }, 'header.event'), 'header.event')
  assert.equal(agentWebhookEventName({ event: 'body.event' }, null), 'body.event')
  assert.equal(agentWebhookEventName({ type: 'body.type' }, null), 'body.type')
})
