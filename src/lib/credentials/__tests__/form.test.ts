/**
 * Credential editor form logic. The rule worth protecting: a blank secret field
 * is OMITTED from the save body, never sent as ''. Sending '' would store an
 * empty credential on create and silently wipe a working one on edit.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { draftFromRedacted, draftProblems, emptyDraft, fieldsForType, parseAllowedDomains, saveBody } from '../form'
import { CREDENTIAL_TYPES } from '../types'

test('every credential type declares its fields', () => {
  for (const type of CREDENTIAL_TYPES) {
    assert.ok(fieldsForType(type).length > 0, `${type} has no fields`)
  }
})

test('a new bearer credential requires a name and a token', () => {
  const draft = { ...emptyDraft(), type: 'bearer' as const }
  assert.deepEqual(draftProblems(draft, false), ['Give this credential a name.', 'Token is required.'])
  assert.deepEqual(draftProblems({ ...draft, name: 'A', token: 't' }, false), [])
})

test('editing allows a blank secret — it means keep the stored one', () => {
  const draft = { ...emptyDraft(), type: 'bearer' as const, name: 'A' }
  assert.deepEqual(draftProblems(draft, true), [])
  assert.deepEqual(draftProblems(draft, false), ['Token is required.'])
})

test('a blank secret is omitted from the save body, not sent empty', () => {
  const draft = { ...emptyDraft(), type: 'apiKeyHeader' as const, name: 'A', headerName: 'X-K', key: '   ' }
  const body = saveBody(draft, true)
  assert.equal('key' in body, false, 'a blank secret must not be sent')
  assert.equal(body.headerName, 'X-K')
})

test('a supplied secret IS sent verbatim, including surrounding characters', () => {
  const draft = { ...emptyDraft(), type: 'bearer' as const, name: 'A', token: ' sk-1 ' }
  // Trim decides whether to send; the value itself is untouched, because a
  // token's leading/trailing bytes can be significant.
  assert.equal(saveBody(draft, false).token, ' sk-1 ')
})

test('custom entries drop rows missing a name or a value', () => {
  const draft = {
    ...emptyDraft(),
    type: 'custom' as const,
    name: 'A',
    headers: [{ name: 'X-A', value: 'a' }, { name: '', value: 'orphan' }, { name: 'X-B', value: '' }],
    query: [{ name: '', value: '' }],
  }
  const body = saveBody(draft, false)
  assert.deepEqual(body.headers, [{ name: 'X-A', value: 'a' }])
  assert.equal('query' in body, false)
})

test('custom requires at least one named entry', () => {
  const draft = { ...emptyDraft(), type: 'custom' as const, name: 'A' }
  assert.deepEqual(draftProblems(draft, false), ['Add at least one header or query parameter.'])
})

test('allowedDomains parses a comma list and drops blanks', () => {
  assert.deepEqual(parseAllowedDomains(' acme.com , ,api.other.io '), ['acme.com', 'api.other.io'])
  assert.deepEqual(parseAllowedDomains(''), [])
})

test('seeding from a redacted credential never prefills a secret', () => {
  const draft = draftFromRedacted({
    name: 'Acme',
    type: 'apiKeyHeader',
    personal: true,
    allowedDomains: ['acme.com'],
    config: { type: 'apiKeyHeader', headerName: 'X-K', hasKey: true },
  })
  assert.equal(draft.name, 'Acme')
  assert.equal(draft.headerName, 'X-K')
  assert.equal(draft.personal, true)
  assert.equal(draft.allowedDomains, 'acme.com')
  // hasKey said a key exists; the value is not available and must stay blank.
  assert.equal(draft.key, '')
})

test('seeding custom entries keeps the names and blanks the values', () => {
  const draft = draftFromRedacted({
    name: 'C',
    type: 'custom',
    personal: false,
    allowedDomains: [],
    config: { type: 'custom', headers: [{ name: 'X-A', hasValue: true }], query: [] },
  })
  assert.deepEqual(draft.headers, [{ name: 'X-A', value: '' }])
  // An empty query list still yields one blank row to type into.
  assert.deepEqual(draft.query, [{ name: '', value: '' }])
})

test('the personal flag and domains always travel', () => {
  const body = saveBody({ ...emptyDraft(), name: 'A', token: 't', personal: true, allowedDomains: 'acme.com' }, false)
  assert.equal(body.personal, true)
  assert.deepEqual(body.allowedDomains, ['acme.com'])
})
