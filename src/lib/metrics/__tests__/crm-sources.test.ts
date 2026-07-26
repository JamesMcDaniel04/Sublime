import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeHubspotMetricSource } from '../sources/hubspot'
import { makeSalesforceMetricSource } from '../sources/salesforce'
import type { NangoProxy } from '@/lib/nango/delivery'

const connection = { connectionId: 'conn-1', providerConfigKey: 'hubspot' }
const ctx = { organizationId: 'org-1', connectionRef: 'nango:conn-1', config: {} }

test('hubspot pipeline_value sums open deal amounts across pages', async () => {
  const pages = [
    {
      results: [
        { properties: { amount: '1000' } },
        { properties: { amount: '250.50' } },
      ],
      paging: { next: { after: 'p2' } },
    },
    { results: [{ properties: { amount: '749.50' } }] },
  ]
  let call = 0
  const proxy: NangoProxy = async (args) => {
    const body = args.data as { filterGroups?: unknown[] }
    assert.ok(Array.isArray(body.filterGroups), 'open-deal filter present')
    return { data: pages[call++] }
  }
  const source = makeHubspotMetricSource(proxy, async () => connection)
  const reading = await source.fetchValue(ctx, 'hubspot.pipeline_value')
  assert.equal(reading.value, 2000)
  assert.equal(call, 2)
})

test('hubspot closed_won filters by closedate >= periodStart', async () => {
  let sentFilters: unknown
  const proxy: NangoProxy = async (args) => {
    sentFilters = (args.data as { filterGroups: unknown }).filterGroups
    return { data: { results: [{ properties: { amount: '5000' } }] } }
  }
  const source = makeHubspotMetricSource(proxy, async () => connection)
  const reading = await source.fetchValue(
    { ...ctx, config: { periodStartIso: '2026-01-01T00:00:00Z' } },
    'hubspot.closed_won',
  )
  assert.equal(reading.value, 5000)
  assert.match(JSON.stringify(sentFilters), /closedate/)
})

test('salesforce pipeline_value reads the SOQL aggregate', async () => {
  let soql = ''
  const proxy: NangoProxy = async (args) => {
    soql = String(args.params?.q)
    return { data: { records: [{ total: 41250 }] } }
  }
  const source = makeSalesforceMetricSource(proxy, async () => ({
    ...connection,
    providerConfigKey: 'salesforce',
  }))
  const reading = await source.fetchValue(ctx, 'salesforce.pipeline_value')
  assert.equal(reading.value, 41250)
  assert.match(soql, /IsClosed = false/)
})

test('salesforce closed_won: null aggregate (no rows) reads as 0', async () => {
  const proxy: NangoProxy = async () => ({ data: { records: [{ total: null }] } })
  const source = makeSalesforceMetricSource(proxy, async () => ({
    ...connection,
    providerConfigKey: 'salesforce',
  }))
  const reading = await source.fetchValue(ctx, 'salesforce.closed_won')
  assert.equal(reading.value, 0)
})
