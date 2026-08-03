import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unsubscribeUrl, verifyUnsubscribeToken } from '../unsubscribe'

test('unsubscribe signatures round-trip and reject tampering', () => {
  process.env.EMAIL_LINK_SECRET = 'test-secret'
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example'
  const value = unsubscribeUrl('user_1')!
  const signature = new URL(value).searchParams.get('sig')!
  assert.equal(verifyUnsubscribeToken('user_1', signature), true)
  assert.equal(verifyUnsubscribeToken('user_2', signature), false)
  assert.equal(verifyUnsubscribeToken('user_1', 'bogus'), false)
})

test('marketing links fail closed without signing configuration', () => {
  const linkSecret = process.env.EMAIL_LINK_SECRET
  const cronSecret = process.env.CRON_SECRET
  delete process.env.EMAIL_LINK_SECRET
  delete process.env.CRON_SECRET
  try { assert.equal(unsubscribeUrl('user_1'), null) } finally {
    if (linkSecret) process.env.EMAIL_LINK_SECRET = linkSecret
    if (cronSecret) process.env.CRON_SECRET = cronSecret
  }
})
