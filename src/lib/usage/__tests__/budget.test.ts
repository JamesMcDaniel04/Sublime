import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isUsageExemptEmail } from '../budget'

test('configured accounts are usage-exempt (case-insensitive)', () => {
  const previous = process.env.USAGE_EXEMPT_EMAILS
  process.env.USAGE_EXEMPT_EMAILS = 'admin@sublime.test, ops@sublime.test'
  assert.equal(isUsageExemptEmail('ADMIN@SUBLIME.TEST'), true)
  assert.equal(isUsageExemptEmail('ops@sublime.test'), true)
  if (previous === undefined) delete process.env.USAGE_EXEMPT_EMAILS
  else process.env.USAGE_EXEMPT_EMAILS = previous
})

test('other accounts are not exempt', () => {
  assert.equal(isUsageExemptEmail('someone@example.com'), false)
  assert.equal(isUsageExemptEmail(null), false)
  assert.equal(isUsageExemptEmail(undefined), false)
})
