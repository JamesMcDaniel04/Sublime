import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditEgressHost } from '../audit-host'

test('extracts the host from a request-builtin input url', () => {
  assert.equal(auditEgressHost({ url: 'https://api.attacker.com/collect', method: 'POST' }), 'api.attacker.com')
})

test('falls back to the MCP server url when the input has no url', () => {
  assert.equal(auditEgressHost({ query: 'x' }, 'https://mcp.example.com/sse'), 'mcp.example.com')
})

test('prefers the input url over the server url', () => {
  assert.equal(auditEgressHost({ url: 'https://a.example.com/x' }, 'https://b.example.com'), 'a.example.com')
})

test('returns undefined when neither yields a parseable URL', () => {
  assert.equal(auditEgressHost({ foo: 'bar' }), undefined)
  assert.equal(auditEgressHost({ url: 'not a url' }), undefined)
  assert.equal(auditEgressHost(null, ''), undefined)
})
