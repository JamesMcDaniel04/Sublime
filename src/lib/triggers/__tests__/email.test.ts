/**
 * Email as a flow trigger.
 *
 * Delivered over the Gmail API rather than IMAP. IMAP would need a protocol
 * client dependency and a long-lived connection; Gmail is HTTP with an OAuth
 * token we already store (GoogleOAuthConnection, service 'google-mail'), so
 * this reuses infrastructure instead of adding any. The narrowing is real and
 * stated in the module.
 *
 * The property that matters more than anything else here: a message triggers
 * EXACTLY ONCE. A duplicate trigger means a duplicate reply sent, a duplicate
 * ticket filed, a duplicate charge — the failure people actually notice.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gmailQueryFor, parseGmailMessage, messageIdentity } from '../email'

// ── building the query ──────────────────────────────────────────────────────

test('a bare config polls the inbox for unread mail', () => {
  const query = gmailQueryFor({})
  assert.match(query, /in:inbox/)
  assert.match(query, /is:unread/)
})

test('a sender filter is included', () => {
  assert.match(gmailQueryFor({ from: 'billing@acme.com' }), /from:"billing@acme\.com"/)
})

test('a subject filter is quoted so spaces do not split it', () => {
  assert.match(gmailQueryFor({ subject: 'Invoice due' }), /subject:"Invoice due"/)
})

test('a raw query is used as given rather than being second-guessed', () => {
  assert.equal(gmailQueryFor({ query: 'has:attachment larger:5M' }), 'has:attachment larger:5M')
})

// Reading all mail rather than only unread is a deliberate opt-in: it is the
// setting most likely to cause a flood on first run.
test('including read mail is opt-in', () => {
  assert.doesNotMatch(gmailQueryFor({ includeRead: true }), /is:unread/)
})

// Quoted like every other value: a label with a space is ordinary, and an
// unquoted one would split into a stray bare term.
test('a label narrows the search', () => {
  assert.match(gmailQueryFor({ label: 'Support Tier 1' }), /label:"Support Tier 1"/)
})

// A user-supplied value must not break out of its term and become a separate
// operator. The injected text stays INSIDE the quotes — where it is part of
// the subject being searched for, not an instruction to Gmail.
test('a quote in a filter cannot escape the term', () => {
  const query = gmailQueryFor({ subject: 'say "hello" -in:trash' })
  assert.match(query, /subject:"say hello -in:trash"/)
  // The stray quotes are gone, so nothing after them is read as an operator.
  assert.equal(query.split('"').length - 1, 2, 'the term did not close cleanly')
})

// ── parsing a message ───────────────────────────────────────────────────────

const message = {
  id: 'msg-1',
  threadId: 'thread-1',
  internalDate: '1756143600000',
  snippet: 'The invoice is attached',
  payload: {
    headers: [
      { name: 'From', value: 'Billing <billing@acme.com>' },
      { name: 'To', value: 'ops@example.com' },
      { name: 'Subject', value: 'Invoice 1234' },
      { name: 'Message-ID', value: '<abc@acme.com>' },
    ],
    body: { data: Buffer.from('Full body text').toString('base64url') },
  },
}

test('a message becomes a flat, readable shape', () => {
  const parsed = parseGmailMessage(message)
  assert.equal(parsed.from, 'Billing <billing@acme.com>')
  assert.equal(parsed.subject, 'Invoice 1234')
  assert.equal(parsed.to, 'ops@example.com')
  assert.equal(parsed.body, 'Full body text')
})

test('headers are matched without regard to case', () => {
  const parsed = parseGmailMessage({
    ...message,
    payload: { ...message.payload, headers: [{ name: 'sUbJeCt', value: 'Odd casing' }] },
  })
  assert.equal(parsed.subject, 'Odd casing')
})

test('a message with no body falls back to the snippet', () => {
  const parsed = parseGmailMessage({ ...message, payload: { headers: message.payload.headers } })
  assert.equal(parsed.body, 'The invoice is attached')
})

test('a multipart message reads the plain-text part', () => {
  const parsed = parseGmailMessage({
    ...message,
    payload: {
      headers: message.payload.headers,
      parts: [
        { mimeType: 'text/html', body: { data: Buffer.from('<p>html</p>').toString('base64url') } },
        { mimeType: 'text/plain', body: { data: Buffer.from('plain text').toString('base64url') } },
      ],
    },
  })
  assert.equal(parsed.body, 'plain text')
})

test('a missing field is empty rather than undefined', () => {
  const parsed = parseGmailMessage({ id: 'x' })
  assert.equal(parsed.subject, '')
  assert.equal(parsed.from, '')
  assert.equal(parsed.id, 'x')
})

// A body is bounded: a large email must not be pasted whole into a run row.
test('an enormous body is bounded', () => {
  const huge = 'x'.repeat(200_000)
  const parsed = parseGmailMessage({
    ...message,
    payload: { headers: message.payload.headers, body: { data: Buffer.from(huge).toString('base64url') } },
  })
  assert.ok(parsed.body.length < 100_000, `the body was ${parsed.body.length} characters`)
})

// ── exactly-once ────────────────────────────────────────────────────────────
//
// The property everything else serves.

test('identity is the immutable message id, not anything mutable', () => {
  assert.equal(messageIdentity(parseGmailMessage(message)), 'msg-1')
})

// A subject or timestamp would collide across genuinely distinct messages, and
// change when a message is edited or re-delivered.
test('two messages with identical content are still distinct', () => {
  const a = parseGmailMessage({ ...message, id: 'msg-1' })
  const b = parseGmailMessage({ ...message, id: 'msg-2' })
  assert.notEqual(messageIdentity(a), messageIdentity(b))
})

test('the same message always yields the same identity', () => {
  assert.equal(
    messageIdentity(parseGmailMessage(message)),
    messageIdentity(parseGmailMessage({ ...message, snippet: 'changed', internalDate: '999' })),
  )
})
