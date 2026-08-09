import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { lookupN8nCredential, N8N_CREDENTIAL_MAP_SIZE } from '@/lib/import/n8n-credential-map'
import { N8N_CREDENTIAL_OVERRIDES } from '@/lib/import/n8n-credential-overrides'

test('table meets the size floor so a gutted regeneration cannot ship', () => {
  assert.ok(N8N_CREDENTIAL_MAP_SIZE >= 300, `only ${N8N_CREDENTIAL_MAP_SIZE} entries`)
})

test('lookup is case-insensitive on the n8n credential type name', () => {
  assert.ok(lookupN8nCredential('StripeApi'))
  assert.deepEqual(lookupN8nCredential('stripeapi'), lookupN8nCredential('StripeApi'))
})

test('a non-Authorization-header credential maps with its real header name', () => {
  const entry = lookupN8nCredential('shopifyAccessTokenApi')
  assert.deepEqual(entry, {
    type: 'apiKeyHeader',
    headerName: 'X-Shopify-Access-Token',
    displayName: 'Shopify Access Token API',
  })
})

test('a query-param credential maps with its real param name', () => {
  const entry = lookupN8nCredential('calApi')
  assert.equal(entry?.type, 'apiKeyQuery')
  assert.equal(entry?.type === 'apiKeyQuery' ? entry.queryParam : '', 'apiKey')
})

test('every entry matches the discriminated union with lower-cased keys', () => {
  const raw = fs.readFileSync(path.join(process.cwd(), 'src/lib/import/n8n-credential-map.json'), 'utf8')
  const table = JSON.parse(raw) as Record<string, { type: string; displayName?: string }>
  const kinds = ['basic', 'bearer', 'oauth1', 'oauth2', 'apiKeyHeader', 'apiKeyQuery', 'custom', 'unsupported']
  for (const [key, entry] of Object.entries(table)) {
    assert.ok(kinds.includes(entry.type), `${key} has type ${entry.type}`)
    assert.equal(key, key.toLowerCase(), `${key} key not lower-cased`)
    assert.ok(entry.displayName, `${key} missing displayName`)
  }
})

test('curated overrides win over the generated table for code-authed vendors', () => {
  assert.deepEqual(lookupN8nCredential('notionApi'), { type: 'bearer', displayName: 'Notion API' })
  assert.deepEqual(lookupN8nCredential('openAiApi'), { type: 'bearer', displayName: 'OpenAI' })
  const seatable = lookupN8nCredential('seaTableApi')
  assert.equal(seatable?.type, 'apiKeyHeader')
})

test('tranche-2 overrides resolve to their expected vault shapes', () => {
  assert.deepEqual(lookupN8nCredential('bitlyApi'), { type: 'bearer', displayName: 'Bitly API' })
  assert.deepEqual(lookupN8nCredential('calendlyApi'), { type: 'bearer', displayName: 'Calendly API' })
  assert.deepEqual(lookupN8nCredential('circleCiApi'), {
    type: 'apiKeyHeader',
    headerName: 'Circle-Token',
    displayName: 'CircleCI API',
  })
  assert.deepEqual(lookupN8nCredential('codaApi'), { type: 'bearer', displayName: 'Coda API' })
  assert.deepEqual(lookupN8nCredential('datadogApi'), {
    type: 'custom',
    entries: [
      { kind: 'header', name: 'DD-API-KEY' },
      { kind: 'header', name: 'DD-APPLICATION-KEY' },
    ],
    displayName: 'Datadog API',
  })
  assert.deepEqual(lookupN8nCredential('figmaApi'), {
    type: 'apiKeyHeader',
    headerName: 'X-Figma-Token',
    displayName: 'Figma API',
  })
  assert.deepEqual(lookupN8nCredential('freshdeskApi'), { type: 'basic', displayName: 'Freshdesk API' })
  assert.deepEqual(lookupN8nCredential('httpBasicAuth'), { type: 'basic', displayName: 'Basic Auth' })
  assert.deepEqual(lookupN8nCredential('pagerDutyApi'), {
    type: 'apiKeyHeader',
    headerName: 'Authorization',
    displayName: 'PagerDuty API',
  })
  assert.deepEqual(lookupN8nCredential('surveyMonkeyApi'), { type: 'bearer', displayName: 'SurveyMonkey API' })
  assert.deepEqual(lookupN8nCredential('trelloApi'), {
    type: 'custom',
    entries: [
      { kind: 'query', name: 'key' },
      { kind: 'query', name: 'token' },
    ],
    displayName: 'Trello API',
  })
  assert.deepEqual(lookupN8nCredential('wooCommerceApi'), { type: 'basic', displayName: 'WooCommerce API' })
  assert.deepEqual(lookupN8nCredential('zendeskApi'), { type: 'basic', displayName: 'Zendesk API' })
})

test('every override corrects a generated entry that is marked unsupported', () => {
  // Overrides exist ONLY to rescue code-authed credentials the generator
  // punted on; shadowing a supported generated entry (or inventing a type the
  // generator never saw) would mean the override belongs in the generator.
  // Known intentional shadows of supported-but-wrong generated entries:
  const intentionalShadows = new Set(['airtableapi'])
  const raw = fs.readFileSync(path.join(process.cwd(), 'src/lib/import/n8n-credential-map.json'), 'utf8')
  const table = JSON.parse(raw) as Record<string, { type: string; displayName: string }>
  for (const [key, entry] of Object.entries(N8N_CREDENTIAL_OVERRIDES)) {
    const generated = table[key]
    assert.ok(generated, `override ${key} has no generated counterpart`)
    if (!intentionalShadows.has(key)) {
      assert.equal(generated.type, 'unsupported', `override ${key} shadows a supported generated entry`)
    }
    assert.equal(generated.displayName, entry.displayName, `override ${key} displayName drifted from generated table`)
    assert.notEqual(entry.type, 'unsupported', `override ${key} is pointless (still unsupported)`)
  }
})
