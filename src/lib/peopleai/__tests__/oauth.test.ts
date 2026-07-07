import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  generatePkce,
  buildAuthorizeUrl,
  discoverMetadata,
  exchangeCode,
  refreshTokens,
  type PeopleAiOAuthConfig,
} from '../oauth'

const config: PeopleAiOAuthConfig = {
  clientId: 'client-abc',
  clientSecret: 'secret-xyz',
  redirectUri: 'https://studio.example.com/api/peopleai/callback',
  scope: 'den-studio',
}

test('generatePkce: S256 challenge matches verifier, base64url, RFC length', () => {
  const { verifier, challenge } = generatePkce()
  assert.ok(verifier.length >= 43 && verifier.length <= 128)
  assert.match(verifier, /^[A-Za-z0-9\-._~]+$/)
  const expected = crypto.createHash('sha256').update(verifier).digest('base64url')
  assert.equal(challenge, expected)
})

test('buildAuthorizeUrl: carries every required OAuth parameter', () => {
  const url = new URL(
    buildAuthorizeUrl(config, {
      authorizationEndpoint: 'https://mcp.people.ai/authorize',
      state: 'state-1',
      codeChallenge: 'chal-1',
    }),
  )
  assert.equal(url.origin + url.pathname, 'https://mcp.people.ai/authorize')
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('client_id'), 'client-abc')
  assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri)
  assert.equal(url.searchParams.get('state'), 'state-1')
  assert.equal(url.searchParams.get('code_challenge'), 'chal-1')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('scope'), 'den-studio')
})

test('discoverMetadata: reads the well-known document', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    assert.equal(String(input), 'https://mcp.people.ai/.well-known/oauth-authorization-server')
    return new Response(
      JSON.stringify({
        authorization_endpoint: 'https://mcp.people.ai/authorize',
        token_endpoint: 'https://mcp.people.ai/token',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
  const metadata = await discoverMetadata({ ...config, fetchImpl })
  assert.equal(metadata.authorizationEndpoint, 'https://mcp.people.ai/authorize')
  assert.equal(metadata.tokenEndpoint, 'https://mcp.people.ai/token')
})

test('discoverMetadata: falls back to documented endpoints when discovery fails', async () => {
  const fetchImpl: typeof fetch = async () => new Response('nope', { status: 404 })
  const metadata = await discoverMetadata({ ...config, fetchImpl })
  assert.equal(metadata.authorizationEndpoint, 'https://mcp.people.ai/authorize')
  assert.equal(metadata.tokenEndpoint, 'https://mcp.people.ai/token')
})

test('exchangeCode: posts authorization_code grant with PKCE verifier, parses mcp_* tokens', async () => {
  let body: URLSearchParams | null = null
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(String(input), 'https://mcp.people.ai/token')
    body = new URLSearchParams(String(init?.body))
    return new Response(
      JSON.stringify({ access_token: 'mcp_access', refresh_token: 'mcp_refresh', token_type: 'Bearer' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
  const tokens = await exchangeCode(
    { ...config, fetchImpl },
    { tokenEndpoint: 'https://mcp.people.ai/token', code: 'auth-code-1', codeVerifier: 'verifier-1' },
  )
  assert.equal(tokens.accessToken, 'mcp_access')
  assert.equal(tokens.refreshToken, 'mcp_refresh')
  assert.equal(body!.get('grant_type'), 'authorization_code')
  assert.equal(body!.get('code'), 'auth-code-1')
  assert.equal(body!.get('code_verifier'), 'verifier-1')
  assert.equal(body!.get('redirect_uri'), config.redirectUri)
  assert.equal(body!.get('client_id'), 'client-abc')
})

test('exchangeCode: non-200 throws without echoing the response body', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response('secret-internals', { status: 400 })
  await assert.rejects(
    exchangeCode(
      { ...config, fetchImpl },
      { tokenEndpoint: 'https://mcp.people.ai/token', code: 'bad', codeVerifier: 'v' },
    ),
    (error: Error) => !error.message.includes('secret-internals') && /400/.test(error.message),
  )
})

test('refreshTokens: posts refresh_token grant and keeps old refresh token when absent', async () => {
  let body: URLSearchParams | null = null
  const fetchImpl: typeof fetch = async (_input, init) => {
    body = new URLSearchParams(String(init?.body))
    return new Response(
      JSON.stringify({ access_token: 'mcp_access2', token_type: 'Bearer' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
  const tokens = await refreshTokens(
    { ...config, fetchImpl },
    { tokenEndpoint: 'https://mcp.people.ai/token', refreshToken: 'mcp_refresh_old' },
  )
  assert.equal(body!.get('grant_type'), 'refresh_token')
  assert.equal(body!.get('refresh_token'), 'mcp_refresh_old')
  assert.equal(tokens.accessToken, 'mcp_access2')
  assert.equal(tokens.refreshToken, 'mcp_refresh_old')
})
