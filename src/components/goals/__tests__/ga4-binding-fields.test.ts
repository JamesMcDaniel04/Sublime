import { test } from 'node:test'
import assert from 'node:assert/strict'
import { metricBindingIssue, type MetricBinding } from '../metric-binding-fields'

const binding = (config: Record<string, unknown>): MetricBinding => ({
  label: 'Organic sessions',
  role: 'primary',
  source: 'google_analytics',
  metricKey: 'ga4.sessions_mtd',
  unit: 'count',
  connectionRef: 'google:conn-1',
  config,
})

test('a GA4 binding without a property is not ready to create', () => {
  const issue = metricBindingIssue(binding({}))
  assert.match(issue ?? '', /propert/i)
})

test('a GA4 binding with a property is ready', () => {
  assert.equal(metricBindingIssue(binding({ propertyId: '493820104' })), null)
})

test('whitespace is not a property id', () => {
  assert.match(metricBindingIssue(binding({ propertyId: '   ' })) ?? '', /propert/i)
})
