import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WIDGET_TYPES,
  defaultLayoutForGoal,
  parseDashboardLayout,
  parseDraftLayout,
  resolveLayoutMetricRefs,
} from '../dashboard'

test('default layout reproduces the current detail-page section order', () => {
  const layout = defaultLayoutForGoal()
  assert.deepEqual(layout.widgets.map((widget) => widget.type), [
    'periods',
    'trend',
    'impact',
    'contributions',
    'benchmark',
    'history',
    'rollups',
  ])
  assert.deepEqual(
    layout.widgets.map((widget) => widget.id),
    layout.widgets.map((widget) => `default-${widget.type}`),
  )
})

test('persisted layouts drop invalid widgets and reject hostile envelopes', () => {
  const layout = parseDashboardLayout({
    version: 1,
    widgets: [
      { id: 'a', type: 'nonsense', config: {} },
      { id: 'b', type: 'ratio', config: { numeratorId: 'm1' } },
      { id: 'c', type: 'progress', config: {} },
    ],
  })
  assert.deepEqual(layout?.widgets.map((widget) => widget.type), ['progress'])
  assert.equal(parseDashboardLayout(null), null)
  assert.equal(parseDashboardLayout({ version: 2, widgets: [] }), null)
})

test('draft refs validate bounds and resolve to ids', () => {
  const draft = parseDraftLayout(
    {
      version: 1,
      widgets: [
        { id: 'w1', type: 'trend', config: { metric: 1 } },
        { id: 'w2', type: 'comparison', config: { metrics: [0, 1] } },
        {
          id: 'w3',
          type: 'ratio',
          config: { numerator: 1, denominator: 0, format: 'ratio' },
        },
      ],
    },
    2,
  )
  assert.ok(draft)
  const resolved = resolveLayoutMetricRefs(draft, ['id-a', 'id-b'])
  assert.deepEqual(resolved.widgets[0].config, { metricId: 'id-b' })
  assert.deepEqual(resolved.widgets[1].config, { metricIds: ['id-a', 'id-b'] })
  assert.deepEqual(resolved.widgets[2].config, {
    numeratorId: 'id-b',
    denominatorId: 'id-a',
    format: 'ratio',
  })
  assert.equal(
    parseDraftLayout(
      {
        version: 1,
        widgets: [{ id: 'bad', type: 'trend', config: { metric: 2 } }],
      },
      2,
    ),
    null,
  )
})

test('every widget type has a persisted schema', () => {
  for (const type of WIDGET_TYPES) {
    const config =
      type === 'comparison'
        ? { metricIds: ['a', 'b'] }
        : type === 'ratio'
          ? { numeratorId: 'a', denominatorId: 'b', format: 'percent' }
          : type === 'narrative'
            ? { text: 'hello' }
            : {}
    const layout = parseDashboardLayout({
      version: 1,
      widgets: [{ id: 'x', type, config }],
    })
    assert.equal(layout?.widgets.length, 1, `type ${type} should parse`)
  }
})
