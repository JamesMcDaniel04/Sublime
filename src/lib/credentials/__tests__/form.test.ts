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
  assert.deepEqual(draftProblems(draft, false), ['Give this credential a name.', 'Add at least one allowed domain.', 'Token is required.'])
  assert.deepEqual(draftProblems({ ...draft, name: 'A', token: 't', allowedDomains: 'acme.com' }, false), [])
})

test('editing allows a blank secret — it means keep the stored one', () => {
  const draft = { ...emptyDraft(), type: 'bearer' as const, name: 'A', allowedDomains: 'acme.com' }
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

test('custom entries drop nameless rows but keep valueless ones as markers', () => {
  // A nameless row is nothing but an empty form line. A NAMED row with no
  // value is meaningful — on edit it means "keep the stored secret" — so it
  // has to survive serialization; dropping it is what made renames and
  // removals impossible. draftProblems is what rejects it on create.
  const draft = {
    ...emptyDraft(),
    type: 'custom' as const,
    name: 'A',
    headers: [{ name: 'X-A', value: 'a' }, { name: '', value: 'orphan' }, { name: 'X-B', value: '' }],
    query: [{ name: '', value: '' }],
  }
  const body = saveBody(draft, false)
  assert.deepEqual(body.headers, [{ name: 'X-A', value: 'a' }, { name: 'X-B' }])
  assert.equal('query' in body, false)
})

test('custom requires at least one named entry', () => {
  const draft = { ...emptyDraft(), type: 'custom' as const, name: 'A', allowedDomains: 'acme.com' }
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
  assert.deepEqual(draft.headers, [{ name: 'X-A', value: '', originalName: 'X-A' }])
  // An empty query list still yields one blank row to type into — and that row
  // has no originalName, marking it as new rather than stored.
  assert.deepEqual(draft.query, [{ name: '', value: '' }])
})

test('domains travel but ownership cannot be changed by the client', () => {
  const body = saveBody({ ...emptyDraft(), name: 'A', token: 't', personal: true, allowedDomains: 'acme.com' }, false)
  assert.equal('personal' in body, false)
  assert.deepEqual(body.allowedDomains, ['acme.com'])
})

// ── Custom entries must be editable, not just creatable ─────────────────────

test('a named custom entry with no value is rejected on create', () => {
  const draft = {
    ...emptyDraft(),
    name: 'Acme',
    type: 'custom' as const,
    allowedDomains: 'acme.com',
    headers: [{ name: 'X-Api-Key', value: '' }],
    query: [{ name: '', value: '' }],
  }
  assert.deepEqual(draftProblems(draft, false), ['Give “X-Api-Key” a value.'])
})

test('a stored custom entry may keep its value blank while editing', () => {
  const draft = {
    ...emptyDraft(),
    name: 'Acme',
    type: 'custom' as const,
    allowedDomains: 'acme.com',
    headers: [{ name: 'X-Api-Key', value: '', originalName: 'X-Api-Key' }],
    query: [{ name: '', value: '' }],
  }
  assert.deepEqual(draftProblems(draft, true), [])
})

test('a newly added custom entry still needs a value while editing', () => {
  const draft = {
    ...emptyDraft(),
    name: 'Acme',
    type: 'custom' as const,
    allowedDomains: 'acme.com',
    headers: [
      { name: 'X-Old', value: '', originalName: 'X-Old' },
      { name: 'X-New', value: '' },
    ],
    query: [{ name: '', value: '' }],
  }
  assert.deepEqual(draftProblems(draft, true), ['Give “X-New” a value.'])
})

test('editing sends every surviving entry so renames and removals persist', () => {
  const draft = {
    ...emptyDraft(),
    name: 'Acme',
    type: 'custom' as const,
    headers: [{ name: 'X-Renamed', value: '', originalName: 'X-Old' }],
    query: [{ name: '', value: '' }],
  }
  // X-Delete-Me is absent from the draft, so it must be absent from the body.
  assert.deepEqual(saveBody(draft, true).headers, [{ name: 'X-Renamed', originalName: 'X-Old' }])
})

test('a re-typed value travels instead of the keep-existing marker', () => {
  const draft = {
    ...emptyDraft(),
    name: 'Acme',
    type: 'custom' as const,
    headers: [{ name: 'X-Api-Key', value: 'fresh-secret', originalName: 'X-Api-Key' }],
    query: [{ name: '', value: '' }],
  }
  assert.deepEqual(saveBody(draft, true).headers, [
    { name: 'X-Api-Key', value: 'fresh-secret', originalName: 'X-Api-Key' },
  ])
})

test('seeding from a redacted credential records each entry’s original name', () => {
  const draft = draftFromRedacted({
    name: 'Acme',
    type: 'custom',
    personal: true,
    allowedDomains: [],
    config: { type: 'custom', headers: [{ name: 'X-Api-Key', hasValue: true }], query: [] },
  })
  assert.deepEqual(draft.headers, [{ name: 'X-Api-Key', value: '', originalName: 'X-Api-Key' }])
})
