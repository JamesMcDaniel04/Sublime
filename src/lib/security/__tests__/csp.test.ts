import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { contentSecurityPolicy } from '../csp'

test('production scripts require a per-request nonce', () => {
  const csp = contentSecurityPolicy('abc123', false)
  const script = csp.split('; ').find((directive) => directive.startsWith('script-src'))
  assert.match(script ?? '', /'nonce-abc123'/)
  assert.doesNotMatch(script ?? '', /unsafe-inline/)
  assert.doesNotMatch(script ?? '', /unsafe-eval/)
})

test('development permits eval for the Next debugger but still blocks arbitrary inline scripts', () => {
  const script = contentSecurityPolicy('dev123', true).split('; ').find((directive) => directive.startsWith('script-src'))
  assert.match(script ?? '', /unsafe-eval/)
  assert.doesNotMatch(script ?? '', /unsafe-inline/)
})

// The nonce above is only satisfiable while Next renders dynamically. A
// prerendered route is built with no request, so its cached HTML carries no
// nonce, the inline RSC payload is blocked, and the route serves a blank white
// page — which is exactly what /auth/login and /auth/signup did in production.
// The root layout opts the whole tree out of prerendering; these assertions
// fail loudly if that opt-out or the nonce plumbing is ever dropped, because
// nothing else in the suite would notice until the site went blank.
test('the root layout keeps every route dynamic so the CSP nonce can be applied', () => {
  const layout = readFileSync(new URL('../../../app/layout.tsx', import.meta.url), 'utf8')
  assert.match(layout, /export const dynamic = 'force-dynamic'/)
})

test('the request nonce is forwarded to providers that inline their own scripts', () => {
  const layout = readFileSync(new URL('../../../app/layout.tsx', import.meta.url), 'utf8')
  assert.match(layout, /headers\(\)\)\.get\('x-nonce'\)/)
  assert.match(layout, /<ClientProviders nonce=\{nonce\}>/)

  const providers = readFileSync(new URL('../../../components/providers/client-providers.tsx', import.meta.url), 'utf8')
  assert.match(providers, /nonce=\{nonce\}/)
})
