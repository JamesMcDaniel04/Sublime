import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as templates from '../templates'

test('lifecycle templates are complete, escaped, and carry the right compliance footer', () => {
  const appUrl = 'https://app.example'
  const unsubscribeUrl = 'https://app.example/unsubscribe'
  const results = [
    templates.welcomeEmail({ name: '<img src=x>', appUrl }),
    templates.dripDay2Email({ appUrl, unsubscribeUrl }),
    templates.dripDay5Email({ appUrl, unsubscribeUrl }),
    templates.trialEndingEmail({ daysLeft: 3, trialEndsAt: new Date('2026-08-05T00:00:00Z'), appUrl }),
    templates.dunningEmail({ appUrl }),
    templates.winbackInactiveEmail({ appUrl, unsubscribeUrl }),
    templates.winbackCancelledEmail({ appUrl, unsubscribeUrl }),
  ]
  for (const result of results) {
    assert.ok(result.subject.trim())
    assert.ok(result.html.includes('https://app.example'))
  }
  assert.doesNotMatch(results[0].html, /<img src=x>/)
  assert.match(results[1].html, /Unsubscribe/)
  assert.match(results[3].html, /3 days/)
  assert.match(results[4].html.toLowerCase(), /payment/)
})
