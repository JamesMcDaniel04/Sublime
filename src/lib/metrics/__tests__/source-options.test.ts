import assert from 'node:assert/strict'
import test from 'node:test'
import { connectedSourceSet, type MetricSourceOption } from '../source-options'

const option = (
  source: string,
  extra: Partial<MetricSourceOption> = {},
): MetricSourceOption => ({
  source,
  group: 'source_of_truth',
  metrics: [],
  connections: [],
  ...extra,
})

test('a source counts as connected when it has a connection, is available, or is manual', () => {
  const set = connectedSourceSet([
    option('stripe', { connections: [{ ref: 'conn_1', label: 'Acme' }] }),
    option('hubspot'),
    option('url', { available: true }),
    option('manual', { group: 'start_now' }),
  ])
  assert.deepEqual([...set].sort(), ['manual', 'stripe', 'url'])
})

test('an empty option list yields an empty set, not a throw', () => {
  assert.equal(connectedSourceSet([]).size, 0)
})
