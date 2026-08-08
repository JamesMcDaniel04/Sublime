import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyN8nCredential, type N8nCredentialDef } from '@/lib/import/n8n-credential-classify'

const def = (over: Partial<N8nCredentialDef>): N8nCredentialDef => ({
  name: 'exampleApi',
  displayName: 'Example API',
  extends: [],
  authenticate: undefined,
  ...over,
})

test('Authorization Bearer header classifies as bearer', () => {
  const entry = classifyN8nCredential(
    def({
      authenticate: { type: 'generic', properties: { headers: { Authorization: '=Bearer {{$credentials.accessToken}}' } } },
    }),
  )
  assert.deepEqual(entry, { type: 'bearer', displayName: 'Example API' })
})

test('Authorization Basic header classifies as basic', () => {
  const entry = classifyN8nCredential(
    def({
      authenticate: { type: 'generic', properties: { headers: { Authorization: '=Basic {{$credentials.encoded}}' } } },
    }),
  )
  assert.equal(entry.type, 'basic')
})

test('auth block classifies as basic', () => {
  const entry = classifyN8nCredential(
    def({
      authenticate: { type: 'generic', properties: { auth: { username: '={{$credentials.user}}', password: '={{$credentials.pass}}' } } },
    }),
  )
  assert.equal(entry.type, 'basic')
})

test('single non-Authorization header carries the real header name', () => {
  const entry = classifyN8nCredential(
    def({
      authenticate: { type: 'generic', properties: { headers: { 'X-API-Key': '={{$credentials.apiKey}}' } } },
    }),
  )
  assert.deepEqual(entry, { type: 'apiKeyHeader', headerName: 'X-API-Key', displayName: 'Example API' })
})

test('Authorization header with a non-bearer scheme is apiKeyHeader on Authorization', () => {
  const entry = classifyN8nCredential(
    def({
      authenticate: { type: 'generic', properties: { headers: { Authorization: '=Token {{$credentials.apiKey}}' } } },
    }),
  )
  assert.deepEqual(entry, { type: 'apiKeyHeader', headerName: 'Authorization', displayName: 'Example API' })
})

test('single qs param carries the real param name', () => {
  const entry = classifyN8nCredential(
    def({
      authenticate: { type: 'generic', properties: { qs: { api_key: '={{$credentials.apiKey}}' } } },
    }),
  )
  assert.deepEqual(entry, { type: 'apiKeyQuery', queryParam: 'api_key', displayName: 'Example API' })
})

test('multiple static headers/params classify as custom with named entries', () => {
  const entry = classifyN8nCredential(
    def({
      authenticate: {
        type: 'generic',
        properties: {
          headers: { 'X-App-Id': '={{$credentials.id}}', 'X-App-Key': '={{$credentials.key}}' },
          qs: { region: '={{$credentials.region}}' },
        },
      },
    }),
  )
  assert.deepEqual(entry, {
    type: 'custom',
    entries: [
      { kind: 'header', name: 'X-App-Id' },
      { kind: 'header', name: 'X-App-Key' },
      { kind: 'query', name: 'region' },
    ],
    displayName: 'Example API',
  })
})

test('extends oAuth2Api classifies as oauth2, oAuth1Api as oauth1', () => {
  assert.equal(classifyN8nCredential(def({ extends: ['oAuth2Api'] })).type, 'oauth2')
  assert.equal(classifyN8nCredential(def({ extends: ['oAuth1Api'] })).type, 'oauth1')
})

test('body-based auth is unsupported', () => {
  const entry = classifyN8nCredential(
    def({
      authenticate: { type: 'generic', properties: { body: { token: '={{$credentials.token}}' } } },
    }),
  )
  assert.equal(entry.type, 'unsupported')
})

test('no recipe and no extends is unsupported (programmatic auth)', () => {
  const entry = classifyN8nCredential(def({}))
  assert.deepEqual(entry, { type: 'unsupported', reason: 'programmatic', displayName: 'Example API' })
})

test('expression-valued header NAME is unsupported — a wrong prefilled name is worse than none', () => {
  const entry = classifyN8nCredential(
    def({
      authenticate: { type: 'generic', properties: { headers: { '={{$credentials.headerName}}': '=x' } } },
    }),
  )
  assert.equal(entry.type, 'unsupported')
})

test('displayName falls back to the credential name when missing', () => {
  const entry = classifyN8nCredential(def({ displayName: '' }))
  assert.equal(entry.displayName, 'exampleApi')
})
