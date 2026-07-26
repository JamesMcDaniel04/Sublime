import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateCopilotDraft,
  draftGoalDashboard,
  CopilotDraftError,
} from '../copilot'
import type { MetricSourceOption } from '@/lib/metrics/available-sources'

const NOW = new Date('2026-07-26T12:00:00Z')
const SOURCES: MetricSourceOption[] = [
  {
    source: 'manual',
    group: 'start_now',
    available: true,
    metrics: [
      {
        key: 'manual.value',
        label: 'Manually recorded value',
        unit: 'usd',
      },
    ],
    connections: [],
  },
  {
    source: 'stripe',
    group: 'source_of_truth',
    metrics: [{ key: 'stripe.mrr', label: 'MRR', unit: 'usd' }],
    connections: [{ ref: 'credential:c1', label: 'Prod Stripe' }],
  },
  {
    source: 'hubspot',
    group: 'source_of_truth',
    metrics: [
      { key: 'hubspot.new_leads', label: 'New leads', unit: 'count' },
    ],
    connections: [{ ref: 'nango:h1', label: 'Prod HubSpot' }],
  },
]

const baseOutput = () => ({
  name: 'Grow demo-sourced revenue',
  description: null,
  kind: 'revenue',
  direction: 'increase' as const,
  unit: 'usd' as const,
  recurrence: 'monthly' as const,
  personal: false,
  suggestedTarget: {
    value: 50000,
    rationale: 'Roughly 20% above the described current run rate.',
  },
  suggestedTargetDate: '2026-10-31',
  metrics: [
    {
      label: 'Closed revenue',
      role: 'primary' as 'primary' | 'supporting',
      source: 'stripe',
      metricKey: 'stripe.mrr',
      unit: 'usd' as const,
      config: {},
    },
    {
      label: 'Demos booked',
      role: 'supporting' as 'primary' | 'supporting',
      source: 'hubspot',
      metricKey: 'hubspot.new_leads',
      unit: 'count' as const,
      config: {},
    },
  ],
  widgets: [
    { id: 'w-kpi', type: 'kpi', config: { metric: 0 } },
    { id: 'w-trend', type: 'trend', config: { metric: 0 } },
    {
      id: 'w-ratio',
      type: 'ratio',
      config: { numerator: 0, denominator: 1, format: 'ratio' },
    },
    {
      id: 'w-note',
      type: 'narrative',
      config: {
        text: 'Demos convert to revenue; both series on one page.',
      },
    },
  ],
  rationale: 'Blends lead_gen and revenue tracking.',
})
const makeRaw = (
  mutate: (draft: ReturnType<typeof baseOutput>) => void = () => {},
) => {
  const draft = baseOutput()
  mutate(draft)
  return JSON.stringify(draft)
}

test('a clean draft validates with no notes', () => {
  const { draft, notes } = validateCopilotDraft(makeRaw(), SOURCES, NOW)
  assert.deepEqual(notes, [])
  assert.equal(draft.kind, 'revenue')
  assert.equal(draft.metrics.length, 2)
  assert.equal(draft.metrics[0].connectionRef, 'credential:c1')
  assert.equal(draft.layout?.widgets.length, 4)
})

test('unknown kind and unreadable JSON are unusable', () => {
  assert.throws(
    () =>
      validateCopilotDraft(
        makeRaw((draft) => {
          draft.kind = 'happiness'
        }),
        SOURCES,
        NOW,
      ),
    CopilotDraftError,
  )
  assert.throws(
    () => validateCopilotDraft('not json', SOURCES, NOW),
    CopilotDraftError,
  )
})

test('unavailable and hallucinated sources fall back to manual', () => {
  const unavailableSources = SOURCES.map((source) =>
    source.source === 'hubspot' ? { ...source, connections: [] } : source,
  )
  const unavailable = validateCopilotDraft(
    makeRaw(),
    unavailableSources,
    NOW,
  )
  assert.equal(unavailable.draft.metrics[1].source, 'manual')
  assert.equal(unavailable.draft.metrics[1].metricKey, 'manual.value')
  assert.equal(unavailable.notes.length, 1)

  const hallucinated = validateCopilotDraft(
    makeRaw((draft) => {
      draft.metrics[0].source = 'quickbooks'
    }),
    SOURCES,
    NOW,
  )
  assert.equal(hallucinated.draft.metrics[0].source, 'manual')
})

test('primary role is repaired deterministically', () => {
  const duplicate = validateCopilotDraft(
    makeRaw((draft) => {
      draft.metrics[1].role = 'primary'
    }),
    SOURCES,
    NOW,
  )
  assert.deepEqual(
    duplicate.draft.metrics.map((metric) => metric.role),
    ['primary', 'supporting'],
  )
  const missing = validateCopilotDraft(
    makeRaw((draft) => {
      draft.metrics[0].role = 'supporting'
    }),
    SOURCES,
    NOW,
  )
  assert.equal(missing.draft.metrics[0].role, 'primary')
})

test('invalid widgets and target dates degrade with notes', () => {
  const widgets = validateCopilotDraft(
    makeRaw((draft) => {
      draft.widgets = [{ id: 'x', type: 'pie3d', config: {} } as never]
    }),
    SOURCES,
    NOW,
  )
  assert.equal(widgets.draft.layout, null)
  assert.ok(widgets.notes.length >= 1)

  const date = validateCopilotDraft(
    makeRaw((draft) => {
      draft.suggestedTargetDate = '2025-01-01'
    }),
    SOURCES,
    NOW,
  )
  assert.equal(date.draft.suggestedTargetDate, null)
  assert.ok(date.notes.some((note) => note.toLowerCase().includes('date')))
})

test('kind implies unit even when the model disagrees', () => {
  const { draft } = validateCopilotDraft(
    makeRaw((value) => {
      value.kind = 'lead_gen'
      value.unit = 'usd'
    }),
    SOURCES,
    NOW,
  )
  assert.equal(draft.unit, 'count')
})

test('draftGoalDashboard threads an injected generator', async () => {
  const calls: unknown[] = []
  const { draft } = await draftGoalDashboard({
    description: 'grow demo bookings and the revenue they convert to',
    sources: SOURCES,
    now: NOW,
    generate: async (options) => {
      calls.push(options)
      return makeRaw()
    },
  })
  assert.equal(calls.length, 1)
  assert.equal(draft.name, 'Grow demo-sourced revenue')
  const options = calls[0] as { schemaName: string; user: string }
  assert.equal(options.schemaName, 'goal_copilot_draft')
  assert.ok(options.user.includes('demo bookings'))
})

test('provider failures remain provider failures', async () => {
  await assert.rejects(
    draftGoalDashboard({
      description: 'x',
      sources: SOURCES,
      now: NOW,
      generate: async () => {
        throw new Error('boom')
      },
    }),
    (error: unknown) => !(error instanceof CopilotDraftError),
  )
})
