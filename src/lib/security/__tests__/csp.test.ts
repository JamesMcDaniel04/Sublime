import { test } from 'node:test'
import assert from 'node:assert/strict'
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
