/**
 * apiLogger is the LAST unscrubbed sink: Sentry events and the LLM transcript
 * both pass through redactSecrets, but stdout did not — and stdout is exactly
 * where a third-party client error carrying a tokenised URL or header lands
 * (Vercel/Fly log drains index it verbatim).
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { apiLogger } from '../logger'

const BEARER = 'Bearer abcdefghijklmnopqrstuvwxyz0123456789'
const SLACK = 'xoxb-1234567890-abcdefghijklmnop'

const original = { error: console.error, warn: console.warn, log: console.log }

afterEach(() => {
  console.error = original.error
  console.warn = original.warn
  console.log = original.log
})

function capture(method: 'error' | 'warn' | 'log'): { lines: string[] } {
  const captured = { lines: [] as string[] }
  console[method] = (...args: unknown[]) => {
    captured.lines.push(
      args
        .map((a) => {
          if (typeof a === 'string') return a
          try {
            return JSON.stringify(a)
          } catch {
            return String(a)
          }
        })
        .join(' '),
    )
  }
  return captured
}

test('a secret in the message is redacted before it reaches stdout', () => {
  const captured = capture('error')
  apiLogger.error(`request failed: ${BEARER}`)
  const joined = captured.lines.join('\n')
  assert.ok(!joined.includes('abcdefghijklmnopqrstuvwxyz0123456789'), 'bearer token reached stdout')
  assert.match(joined, /\[redacted:/)
})

test('a secret nested in meta is redacted before it reaches stdout', () => {
  const captured = capture('warn')
  apiLogger.warn('connection failed', { config: { token: SLACK }, path: '/api/x' })
  const joined = captured.lines.join('\n')
  assert.ok(!joined.includes(SLACK), 'slack token reached stdout via meta')
  assert.ok(joined.includes('/api/x'), 'ordinary diagnostic meta was lost')
})

test('ordinary messages and meta pass through intact', () => {
  const captured = capture('log')
  apiLogger.info('cache miss', { key: 'goals:123', durationMs: 45 })
  const joined = captured.lines.join('\n')
  assert.ok(joined.includes('cache miss'))
  assert.ok(joined.includes('goals:123'))
  assert.ok(joined.includes('45'))
})

test('meta that cannot be serialised still logs the message', () => {
  const captured = capture('error')
  const circular: Record<string, unknown> = {}
  circular.self = circular
  apiLogger.error('boom', circular)
  assert.ok(captured.lines.join('\n').includes('boom'), 'message was dropped with unserialisable meta')
})
