import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assembleRecoveryCandidates } from '../recovery-candidates'
import type { MetricSourceOption } from '@/lib/metrics/source-options'

const seeds = [
  {
    seedKey: 'pipeline-reviver',
    name: 'Pipeline Reviver',
    description: 'revive stale deals',
    departments: ['sales'],
    requiredIntegrations: ['salesforce'],
    recommendedIntegrations: [],
    kind: 'flow',
    goalKinds: ['arr'],
    estimatedMinutesSaved: 30,
  },
  {
    seedKey: 'outbound-writer',
    name: 'Outbound Writer',
    description: 'draft outbound',
    departments: ['sales'],
    requiredIntegrations: [],
    recommendedIntegrations: [],
    kind: 'agent',
    goalKinds: ['arr'],
  },
  {
    seedKey: 'expense-auditor',
    name: 'Expense Auditor',
    description: 'audit spend',
    departments: ['operations'],
    requiredIntegrations: [],
    recommendedIntegrations: [],
    kind: 'agent',
    goalKinds: ['savings'],
  },
] as never[]

const option = (source: string, available: boolean): MetricSourceOption => ({
  source,
  group: 'source_of_truth',
  metrics: [],
  connections: available ? [{ ref: `credential:${source}-1`, label: source }] : [],
})

test('agent templates filter by goal kind and respect adoption ranking', () => {
  const result = assembleRecoveryCandidates({
    goalKind: 'arr',
    seeds,
    adoptionScores: {
      'seed:outbound-writer': { deploys: 2, surviving: 1 },
      'seed:pipeline-reviver': { deploys: 1, surviving: 0 },
    },
    sources: [option('stripe', true)],
    goalTemplateSources: [],
  })
  assert.deepEqual(
    result.agentTemplates.map((template) => template.seedKey),
    ['outbound-writer', 'pipeline-reviver'],
  )
})

test('unconnected goal-template sources become source gaps; connected ones do not', () => {
  const result = assembleRecoveryCandidates({
    goalKind: 'arr',
    seeds: [],
    adoptionScores: {},
    sources: [option('stripe', true), option('hubspot', false)],
    goalTemplateSources: ['stripe', 'hubspot', 'manual'],
  })
  assert.deepEqual(
    result.sourceGaps.map((gap) => gap.source),
    ['hubspot'],
  )
  assert.equal(result.sourceGaps[0].reason, 'goal_template_source')
  assert.equal(result.sourceGaps[0].label, 'HubSpot')
})

test('agent required integrations surface as gaps, deduped against template sources', () => {
  const result = assembleRecoveryCandidates({
    goalKind: 'arr',
    seeds,
    adoptionScores: {},
    sources: [option('salesforce', false)],
    goalTemplateSources: ['salesforce'],
  })
  const salesforceGaps = result.sourceGaps.filter((gap) => gap.source === 'salesforce')
  assert.equal(salesforceGaps.length, 1)
  assert.equal(salesforceGaps[0].reason, 'goal_template_source')
})

test('an agent requirement with no matching source option is not a gap', () => {
  const result = assembleRecoveryCandidates({
    goalKind: 'arr',
    seeds,
    adoptionScores: {},
    sources: [],
    goalTemplateSources: [],
  })
  assert.equal(result.sourceGaps.length, 0)
})

test('manual is never a gap and caps hold (6 templates, 4 gaps)', () => {
  const manySeeds = Array.from({ length: 9 }, (_, index) => ({
    seedKey: `s${index}`,
    name: `S${index}`,
    description: 'd',
    departments: ['sales'],
    requiredIntegrations: [],
    recommendedIntegrations: [],
    kind: 'agent',
    goalKinds: ['arr'],
  })) as never[]
  const result = assembleRecoveryCandidates({
    goalKind: 'arr',
    seeds: manySeeds,
    adoptionScores: {},
    sources: ['stripe', 'hubspot', 'salesforce', 'google_sheets', 'postgres'].map((source) =>
      option(source, false),
    ),
    goalTemplateSources: ['manual', 'stripe', 'hubspot', 'salesforce', 'google_sheets', 'postgres'],
  })
  assert.equal(result.agentTemplates.length, 6)
  assert.equal(result.sourceGaps.length, 4)
  assert.ok(!result.sourceGaps.some((gap) => gap.source === 'manual'))
})
