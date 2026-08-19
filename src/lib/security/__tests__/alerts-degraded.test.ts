/**
 * Detection must fail CLOSED. The security counter rides the shared rate
 * limiter, which fails OPEN (returns ok:true) when its backend is unreachable —
 * so during a Redis outage the counter silently reports "under threshold" and
 * no alert is ever sent, which is the one moment you most want to know the
 * detector is blind. The limiter now flags `degraded` on a backend failure and
 * the evaluator turns that into its own alert, deduped process-locally so a
 * sustained outage does not become an email flood of its own.
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateSecurityThreshold, resetSecurityAlertState } from '../alerts'
import type { RateLimitResult } from '@/lib/ratelimit'

beforeEach(() => {
  resetSecurityAlertState()
  process.env.SECURITY_ALERT_EMAIL = 'sec@example.com'
})

const degradedLimiter = async (): Promise<RateLimitResult> => ({ ok: true, degraded: true })
const healthyUnder = async (): Promise<RateLimitResult> => ({ ok: true })

test('a degraded counter fires a detection-degraded alert instead of staying silent', async () => {
  const sent: Array<{ subject: string }> = []
  await evaluateSecurityThreshold(
    { kind: 'auth.failed', source: '203.0.113.7' },
    { send: async (m) => { sent.push(m) }, limiter: degradedLimiter },
  )
  assert.equal(sent.length, 1)
  assert.match(sent[0].subject, /degraded/i)
})

test('the degraded alert is deduped within the cooldown, even across a sustained outage', async () => {
  const sent: Array<{ subject: string }> = []
  const send = async (m: { subject: string }) => { sent.push(m) }
  await evaluateSecurityThreshold({ kind: 'auth.failed' }, { send, limiter: degradedLimiter })
  await evaluateSecurityThreshold({ kind: 'auth.failed' }, { send, limiter: degradedLimiter })
  await evaluateSecurityThreshold({ kind: 'rate_limit.exceeded' }, { send, limiter: degradedLimiter })
  assert.equal(sent.length, 1, 'a sustained outage must not flood alerts')
})

test('a healthy under-threshold counter stays silent (no false degraded alarm)', async () => {
  const sent: unknown[] = []
  await evaluateSecurityThreshold(
    { kind: 'auth.failed' },
    { send: async (m) => { sent.push(m) }, limiter: healthyUnder },
  )
  assert.equal(sent.length, 0)
})
