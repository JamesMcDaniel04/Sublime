/**
 * The MCP OAuth start route previously forwarded ?scope= verbatim into the
 * authorization redirect — caller-controlled input in a security parameter.
 * sanitizeOAuthScope pins it to the RFC 6749 scope grammar and a sane length.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeOAuthScope } from '../oauth-scope'

test('accepts a single well-formed scope', () => {
  assert.equal(sanitizeOAuthScope('claudeai'), 'claudeai')
})

test('accepts space-separated scopes and collapses extra whitespace', () => {
  assert.equal(sanitizeOAuthScope('  read:tools   write:tools '), 'read:tools write:tools')
})

test('rejects characters outside the RFC 6749 scope charset', () => {
  assert.equal(sanitizeOAuthScope('read"tools'), null)
  assert.equal(sanitizeOAuthScope('read\\tools'), null)
  assert.equal(sanitizeOAuthScope('read\ntools'), null)
})

test('rejects an empty or oversized scope', () => {
  assert.equal(sanitizeOAuthScope(''), null)
  assert.equal(sanitizeOAuthScope('a'.repeat(513)), null)
})
