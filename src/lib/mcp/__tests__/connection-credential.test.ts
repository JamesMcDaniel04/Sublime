/**
 * An MCP server authenticated by a stored credential must produce the same
 * outbound header a per-connection api_key produced, and must never leak the
 * secret when the credential is missing or the domain is not allowed.
 *
 * These cover the pure branches — the ones that decide whether the database is
 * touched at all. Resolution against a real Credential row lives in the
 * credentials route-smoke suite, which has a database.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mcpCredentialPlan } from '../connection-credential'

const CTX = { organizationId: 'org1', userId: 'user1' }

test('a connection with no credentialId resolves to no plan', async () => {
  const plan = await mcpCredentialPlan(
    { serverUrl: 'https://mcp.example.com', authType: 'api_key', authConfig: { apiKey: 'enc', headerName: 'X-Key' } },
    CTX,
  )
  assert.equal(plan, undefined)
})

test('a non api_key connection resolves to no plan', async () => {
  const plan = await mcpCredentialPlan(
    { serverUrl: 'https://mcp.example.com', authType: 'oauth2', authConfig: { credentialId: 'c1' } },
    CTX,
  )
  assert.equal(plan, undefined)
})

test('a malformed authConfig resolves to no plan rather than throwing', async () => {
  for (const authConfig of [null, 'nope', [], undefined]) {
    const plan = await mcpCredentialPlan(
      { serverUrl: 'https://mcp.example.com', authType: 'api_key', authConfig },
      CTX,
    )
    assert.equal(plan, undefined)
  }
})

test('a blank credentialId is treated as absent, not looked up', async () => {
  const plan = await mcpCredentialPlan(
    { serverUrl: 'https://mcp.example.com', authType: 'api_key', authConfig: { credentialId: '   ' } },
    CTX,
  )
  assert.equal(plan, undefined)
})
