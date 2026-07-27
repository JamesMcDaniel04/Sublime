import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  metricBindingIssue,
  type MetricBinding,
} from '../metric-binding-fields'

const binding = (overrides: Partial<MetricBinding>): MetricBinding => ({
  label: 'Series',
  role: 'supporting',
  source: 'manual',
  metricKey: 'manual.value',
  unit: 'usd',
  connectionRef: null,
  config: {},
  ...overrides,
})

test('a manual binding with a label is ready', () => {
  assert.equal(metricBindingIssue(binding({})), null)
})

test('a blank label blocks creation', () => {
  assert.match(metricBindingIssue(binding({ label: '  ' })) ?? '', /name/i)
})

test('a connection-backed source without a connection blocks creation', () => {
  assert.match(metricBindingIssue(binding({ source: 'stripe', metricKey: 'stripe.mrr' })) ?? '', /account/i)
})

test('connectionless sources need no connection', () => {
  assert.equal(
    metricBindingIssue(binding({ source: 'url', metricKey: 'url.value', config: { url: 'https://x.example/y' } })),
    null,
  )
  assert.equal(
    metricBindingIssue(binding({ source: 'slack_assisted', metricKey: 'assisted.value', config: { channel: '#rev' } })),
    null,
  )
})

test('per-source required config is enforced', () => {
  assert.match(metricBindingIssue(binding({ source: 'url', metricKey: 'url.value' })) ?? '', /url/i)
  assert.match(metricBindingIssue(binding({ source: 'slack_assisted', metricKey: 'assisted.value' })) ?? '', /channel/i)
  assert.match(
    metricBindingIssue(binding({ source: 'gmail_assisted', metricKey: 'assisted.value', connectionRef: 'google:g1' })) ?? '',
    /search/i,
  )
  assert.match(
    metricBindingIssue(binding({ source: 'postgres', metricKey: 'postgres.query', connectionRef: 'credential:c1' })) ?? '',
    /query/i,
  )
  assert.match(
    metricBindingIssue(binding({ source: 'google_sheets', metricKey: 'sheets.range', connectionRef: 'google:g1', config: { spreadsheetId: 'abc' } })) ?? '',
    /range/i,
  )
})
