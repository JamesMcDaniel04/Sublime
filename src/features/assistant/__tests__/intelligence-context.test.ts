import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderIntelligenceBlock } from '@/features/assistant/intelligence-context'

const pattern = {
  slug: 's', kind: 'sequence', summary: 'Runs A then edits B', occurrenceCount: 4,
  firstSeenAt: new Date('2026-06-02T00:00:00Z'), lastSeenAt: new Date('2026-07-10T00:00:00Z'), evidence: ['e1'],
}

test('renders patterns and open suggestion into a bounded block', () => {
  const block = renderIntelligenceBlock({
    graphContext: 'Graph facts here.',
    patterns: [pattern],
    openSuggestion: { title: 'Automate Monday review', evidence: ['line 1'] },
  })
  assert.ok(block.includes('Observed usage patterns'))
  assert.ok(block.includes('Runs A then edits B'))
  assert.ok(block.includes('4x'))
  assert.ok(block.includes('Automate Monday review'))
  assert.ok(block.length <= 3000)
})

test('empty inputs render an empty string — surfaces degrade silently', () => {
  assert.equal(renderIntelligenceBlock({ graphContext: '', patterns: [], openSuggestion: null }), '')
})
