import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { lookupN8nCredential, N8N_CREDENTIAL_MAP_SIZE } from '@/lib/import/n8n-credential-map'

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
