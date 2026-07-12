import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseIntegrationMatches, sanitizeIntegrationMatches } from '../ai-search'

const items = [
  { id: 'zendesk', name: 'Zendesk', description: 'Support tickets' },
  { id: 'teams', name: 'Teams', description: 'Team chat' },
]

test('integration AI matches are parsed, constrained to real IDs, deduplicated, and ranked', () => {
  const raw = JSON.stringify({ matches: [
    { id: 'zendesk', reason: 'Receives tickets.' },
    { id: 'fake', reason: 'Hallucinated.' },
    { id: 'teams', reason: 'Alerts the team.' },
    { id: 'zendesk', reason: 'Duplicate.' },
  ] })
  assert.deepEqual(sanitizeIntegrationMatches(parseIntegrationMatches(raw), items), [
    { id: 'zendesk', reason: 'Receives tickets.' },
    { id: 'teams', reason: 'Alerts the team.' },
  ])
})
