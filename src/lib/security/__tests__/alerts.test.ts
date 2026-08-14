/**
 * The audit found comprehensive logging and zero alerting. These cover the
 * alert half — the log half is unconditional and has no branch to test.
 *
 * NOTE ON TEST DESIGN: counters and the alert cooldown are keyed by event KIND
 * and are process-wide, which is the correct production behaviour (a
 * distributed attack still trips one counter, and one email per kind per hour
 * however long it runs). The consequence is that two tests cannot share a
 * kind — the first to cross spends the cooldown for the rest of the process.
 * Each test below therefore owns one kind outright.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateSecurityThreshold, securityAlertsConfigured, type SecurityEvent } from '../alerts'

type Sent = { to: string; subject: string; text: string }

async function drive(event: SecurityEvent, times: number, send?: (input: Sent) => Promise<void>): Promise<Sent[]> {
  const sent: Sent[] = []
  const sender = send ?? (async (input: Sent) => { sent.push(input) })
  for (let i = 0; i < times; i += 1) await evaluateSecurityThreshold(event, sender)
  return sent
}

test('no-ops when SECURITY_ALERT_EMAIL is unset, without touching the counters', async () => {
  delete process.env.SECURITY_ALERT_EMAIL
  assert.equal(securityAlertsConfigured(), false)
  const sent = await drive({ kind: 'rate_limit.exceeded', source: 'probe' }, 5)
  assert.equal(sent.length, 0)
})

test('a single malware hit alerts immediately, with context and without secrets', async () => {
  process.env.SECURITY_ALERT_EMAIL = 'ops@example.com'
  // Deliberate asymmetry: a confirmed malware upload is somebody acting on
  // purpose, so its threshold is 1 rather than waiting for a pattern.
  const sent = await drive(
    {
      kind: 'malware.detected',
      source: '203.0.113.9',
      organizationId: 'org-abc',
      detail: { token: 'xoxb-1234567890-abcdefghij', file: 'invoice.pdf' },
    },
    2,
  )
  assert.equal(sent.length, 1, 'expected exactly one alert')
  assert.equal(sent[0].to, 'ops@example.com')
  assert.match(sent[0].subject, /malware\.detected/)
  assert.match(sent[0].text, /203\.0\.113\.9/)
  assert.match(sent[0].text, /org-abc/)
  assert.match(sent[0].text, /invoice\.pdf/)
  assert.ok(!sent[0].text.includes('xoxb-1234567890-abcdefghij'), 'secret leaked into the alert email')
})

test('stays quiet below the threshold', async () => {
  process.env.SECURITY_ALERT_EMAIL = 'ops@example.com'
  // captcha.failed is 25 per 10 minutes. 20 is a bad afternoon, not an attack.
  const sent = await drive({ kind: 'captcha.failed', source: '198.51.100.2' }, 20)
  assert.equal(sent.length, 0, 'alerted below the threshold')
})

test('one alert per kind however long the attack runs', async () => {
  process.env.SECURITY_ALERT_EMAIL = 'ops@example.com'
  // Past the crossing the counter keeps reporting "over", so without the
  // cooldown every subsequent event would send mail — a detection that turns
  // into an outage of its own.
  const sent = await drive({ kind: 'auth.failed', source: '198.51.100.3' }, 400)
  assert.equal(sent.length, 1, `expected exactly one alert, got ${sent.length}`)
})

test('a failing sender never throws into the caller', async () => {
  process.env.SECURITY_ALERT_EMAIL = 'ops@example.com'
  // Losing the email must not turn a detection into an exception, on a path
  // that was already busy rejecting a request.
  const exploding = async () => { throw new Error('resend is down') }
  await assert.doesNotReject(() =>
    drive({ kind: 'rate_limit.exceeded', source: '198.51.100.4' }, 120, exploding),
  )
})
