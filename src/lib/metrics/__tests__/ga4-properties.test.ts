import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAccountSummaries } from '@/lib/metrics/ga4-properties'

test('flattens account summaries into pickable properties', () => {
  const properties = parseAccountSummaries({
    accountSummaries: [
      {
        displayName: 'Acme',
        propertySummaries: [
          { property: 'properties/493820104', displayName: 'Acme Marketing Site' },
          { property: 'properties/493820105', displayName: 'Acme Docs' },
        ],
      },
      {
        displayName: 'Side Project',
        propertySummaries: [{ property: 'properties/777', displayName: 'Blog' }],
      },
    ],
  })
  assert.deepEqual(properties, [
    { propertyId: '493820104', displayName: 'Acme Marketing Site' },
    { propertyId: '493820105', displayName: 'Acme Docs' },
    { propertyId: '777', displayName: 'Blog' },
  ])
})

test('an account with no properties contributes nothing', () => {
  const properties = parseAccountSummaries({
    accountSummaries: [{ displayName: 'Empty' }],
  })
  assert.deepEqual(properties, [])
})

test('malformed payloads yield an empty list rather than throwing', () => {
  // A picker that renders empty is recoverable; one that 500s is not.
  for (const payload of [null, undefined, {}, { accountSummaries: 'nope' }, []]) {
    assert.deepEqual(parseAccountSummaries(payload), [])
  }
})

test('a property with no display name falls back to its id', () => {
  const properties = parseAccountSummaries({
    accountSummaries: [{ propertySummaries: [{ property: 'properties/42' }] }],
  })
  assert.deepEqual(properties, [{ propertyId: '42', displayName: '42' }])
})
