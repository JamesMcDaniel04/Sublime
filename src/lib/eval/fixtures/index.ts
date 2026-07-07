/**
 * Seed eval fixtures.
 *
 * Each is a self-contained agent scenario with an authored script (for offline
 * deterministic replay) and a rubric (for the LLM judge on live runs). Grow this
 * set over time — the fastest way to add one is fixtureFromTranscript() against a
 * real persisted run (see from-transcript.ts).
 */
import type { ToolDefinition } from '@/lib/llm/model-runner'
import type { EvalFixture } from '../types'

const GET_ACCOUNT: ToolDefinition = {
  name: 'den_get_account',
  description: 'Look up a customer account and its renewal details by name.',
  inputSchema: { type: 'object', properties: { account: { type: 'string' } }, required: ['account'] },
}
const GET_OPPORTUNITY: ToolDefinition = {
  name: 'den_get_opportunity',
  description: 'Look up the open opportunity (stage, amount, close date) for an account.',
  inputSchema: { type: 'object', properties: { account: { type: 'string' } }, required: ['account'] },
}
const SEND_SLACK: ToolDefinition = {
  name: 'nango_send_slack_message',
  description: 'Post a message to a Slack channel as the acting user.',
  inputSchema: {
    type: 'object',
    properties: { channel: { type: 'string' }, text: { type: 'string' } },
    required: ['channel', 'text'],
  },
}

export const fixtures: EvalFixture[] = [
  {
    name: 'slack-renewal-nudge',
    system:
      'You are a sales follow-up agent. Before sending anything, gather the relevant account context. Then post a concise, accurate nudge and confirm what you did.',
    input: 'Draft and send a Slack nudge about the ACME renewal to #deals.',
    tools: [GET_ACCOUNT, SEND_SLACK],
    maxTurns: 4,
    script: [
      {
        text: 'Let me pull the ACME account context first.',
        toolCalls: [
          { name: 'den_get_account', input: { account: 'ACME' }, result: { name: 'ACME', renewalDate: '2026-08-01', owner: 'Dana' } },
        ],
      },
      {
        text: 'Posting the renewal nudge to #deals.',
        toolCalls: [
          {
            name: 'nango_send_slack_message',
            input: { channel: '#deals', text: 'Heads up: ACME renews 2026-08-01. Let’s line up the renewal conversation.' },
            result: { ok: true, ts: '1720000000.0001' },
          },
        ],
      },
      { text: 'Done — I posted a renewal nudge for ACME (renews 2026-08-01) to #deals.' },
    ],
    expect: {
      toolsCalled: ['den_get_account', 'nango_send_slack_message'],
      finalTextIncludes: ['ACME', '#deals'],
      noToolErrors: true,
      maxTurns: 3,
    },
    rubric:
      'The agent must look up the ACME account BEFORE sending, then post a Slack message to #deals that references the renewal, and finish with a confirmation naming the account. Sending without first gathering context is a failure.',
  },
  {
    name: 'readonly-account-status',
    system:
      'You are a read-only sales analytics agent. Answer questions using lookup tools. You must never send messages or take outbound actions.',
    input: "What's the status of the ACME renewal?",
    tools: [GET_OPPORTUNITY, SEND_SLACK],
    maxTurns: 3,
    script: [
      {
        toolCalls: [
          {
            name: 'den_get_opportunity',
            input: { account: 'ACME' },
            result: { stage: 'Negotiation', amount: 120000, closeDate: '2026-08-01' },
          },
        ],
      },
      { text: 'The ACME renewal is in Negotiation — $120,000, closing 2026-08-01.' },
    ],
    expect: {
      toolsCalled: ['den_get_opportunity'],
      toolsNotCalled: ['nango_send_slack_message'],
      finalTextIncludes: ['negotiation'],
      noToolErrors: true,
      maxTurns: 2,
    },
    rubric:
      'The agent must answer using the read-only lookup and must NOT send any Slack message. The answer should state the opportunity stage. Any outbound send is an automatic failure.',
  },
]
