import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeDepartmentWeights, hasNarrativeSignal, personaGraphNode, topPersonaDepartments } from '../weights'

test('zero signal → general only', () => {
  const w = computeDepartmentWeights({ connectedToolSlugs: [], scannedConnectionSlugs: [], activityEventCounts: {} })
  assert.equal(w.general, 1)
  assert.equal(w.sales, 0)
})

test('glue-only connections (slack/gmail) contribute nothing → general', () => {
  const w = computeDepartmentWeights({ connectedToolSlugs: ['slack', 'gmail'], scannedConnectionSlugs: [], activityEventCounts: {} })
  assert.equal(w.general, 1)
  assert.equal(w.engineering, 0)
})

test('anchor connection sets its departments; weights normalize to 1', () => {
  const w = computeDepartmentWeights({ connectedToolSlugs: ['github'], scannedConnectionSlugs: [], activityEventCounts: {} })
  assert.equal(w.engineering, 1)
  const total = Object.values(w).reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(total - 1) < 1e-9)
})

test('a scanned connection outweighs a merely-connected one', () => {
  const w = computeDepartmentWeights({
    connectedToolSlugs: ['github', 'zendesk'],
    scannedConnectionSlugs: ['zendesk'],
    activityEventCounts: {},
  })
  // zendesk: 1 (connected) + 2 (scanned) = 3 → csm; github: 1 → engineering
  assert.ok(w.csm > w.engineering)
})

test('activity weight is log-scaled and capped so raw volume cannot swamp everything', () => {
  const w = computeDepartmentWeights({
    connectedToolSlugs: ['salesforce'],
    scannedConnectionSlugs: [],
    activityEventCounts: { github: 10_000_000 }, // log10(1e7+1) ≈ 7, capped at 3
  })
  // salesforce → +1 each to sales/finance/csm (total 3); github activity → capped 3 to engineering.
  // engineering = 3 / 6 = 0.5; uncapped it would be ~7/10 = 0.7.
  assert.ok(w.engineering <= 0.5 + 1e-9)
})

test('duplicate slugs count once per signal kind', () => {
  const one = computeDepartmentWeights({ connectedToolSlugs: ['github'], scannedConnectionSlugs: [], activityEventCounts: {} })
  const dup = computeDepartmentWeights({ connectedToolSlugs: ['github', 'github'], scannedConnectionSlugs: [], activityEventCounts: {} })
  assert.deepEqual(dup, one)
})

test('hasNarrativeSignal: a scan profile or activity flips it; connections alone never do', () => {
  assert.equal(hasNarrativeSignal({ connectedToolSlugs: ['github'], scannedConnectionSlugs: [], activityEventCounts: {} }), false)
  assert.equal(hasNarrativeSignal({ connectedToolSlugs: [], scannedConnectionSlugs: ['github'], activityEventCounts: {} }), true)
  assert.equal(hasNarrativeSignal({ connectedToolSlugs: [], scannedConnectionSlugs: [], activityEventCounts: { slack: 5 } }), true)
  assert.equal(hasNarrativeSignal({ connectedToolSlugs: [], scannedConnectionSlugs: [], activityEventCounts: { slack: 0 } }), false)
})

test('personaGraphNode: stable id, insight type, top departments + narrative in text', () => {
  const node = personaGraphNode('org-1', { sales: 0.6, engineering: 0.4, marketing: 0, finance: 0, csm: 0, general: 0 }, 'A sales-led team.')
  assert.equal(node.id, 'persona:org-1')
  assert.equal(node.type, 'insight')
  assert.ok(node.text.includes('sales'))
  assert.ok(node.text.includes('A sales-led team.'))
  assert.equal((node.props as { kind?: string }).kind, 'persona')
  assert.equal(node.visibility, 'shared')
})

test('topPersonaDepartments: sorted desc, excludes general and zeros, tolerant of junk', () => {
  assert.deepEqual(topPersonaDepartments({ sales: 0.2, engineering: 0.7, general: 0.1, finance: 0 }), ['engineering', 'sales'])
  assert.deepEqual(topPersonaDepartments(null), [])
  assert.deepEqual(topPersonaDepartments('junk'), [])
})
