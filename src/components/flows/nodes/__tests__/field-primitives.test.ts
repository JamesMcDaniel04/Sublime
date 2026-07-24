/**
 * The pure helpers every node body shapes its field values with.
 *
 * These assertions document ACTUAL behaviour as extracted, not desired
 * behaviour — this module was moved verbatim out of step-card.tsx, so a
 * surprising expectation here (junk preserved rather than blanked, `email2`
 * rather than `email_2`) is the real contract that existing flows depend on.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  INPUT_TYPES,
  inputTypeForField,
  isRecord,
  parseKeyValueRows,
  serializeKeyValueRows,
  uniqueFieldName,
} from '../field-primitives'
import type { OutputField } from '@/lib/flows/graph'

test('key/value rows round-trip through serialize → parse', () => {
  const rows = [{ key: 'X-Api-Version', value: '2' }, { key: 'Accept', value: 'application/json' }]
  assert.deepEqual(parseKeyValueRows(serializeKeyValueRows(rows)), rows)
})

test('serializeKeyValueRows drops keyless rows and trims keys', () => {
  // The editor always keeps one blank row for typing into; it must not persist.
  const serialized = serializeKeyValueRows([{ key: '  Accept ', value: 'json' }, { key: '', value: 'orphan' }])
  assert.deepEqual(JSON.parse(serialized), { Accept: 'json' })
})

test('serializeKeyValueRows returns empty string when nothing is keyed', () => {
  assert.equal(serializeKeyValueRows([{ key: '', value: '' }]), '')
})

test('parseKeyValueRows preserves unparseable text as a value rather than losing it', () => {
  // A half-finished edit must survive a re-render — blanking it would silently
  // eat what the user typed.
  assert.deepEqual(parseKeyValueRows('not json'), [{ key: '', value: 'not json' }])
  assert.deepEqual(parseKeyValueRows('[1,2]'), [{ key: '', value: '[1,2]' }])
})

test('parseKeyValueRows yields one blank row for empty input', () => {
  assert.deepEqual(parseKeyValueRows(undefined), [{ key: '', value: '' }])
  assert.deepEqual(parseKeyValueRows('   '), [{ key: '', value: '' }])
  assert.deepEqual(parseKeyValueRows('{}'), [{ key: '', value: '' }])
})

test('parseKeyValueRows stringifies non-string values', () => {
  assert.deepEqual(parseKeyValueRows('{"n":2,"b":true}'), [{ key: 'n', value: '2' }, { key: 'b', value: 'true' }])
})

test('uniqueFieldName suffixes with a bare index until it stops colliding', () => {
  const fields = [{ name: 'email', type: 'string' }, { name: 'email2', type: 'string' }] as OutputField[]
  assert.equal(uniqueFieldName('email', fields), 'email3')
  assert.equal(uniqueFieldName('phone', fields), 'phone')
})

test('inputTypeForField picks by declared type first, then by name hints', () => {
  assert.equal(inputTypeForField({ name: 'active', type: 'boolean' } as OutputField).id, 'yesno')
  assert.equal(inputTypeForField({ name: 'count', type: 'number' } as OutputField).id, 'number')
  // A string field named "email" is an email input — the hint only applies
  // once the declared type hasn't already decided.
  assert.equal(inputTypeForField({ name: 'contact_email', type: 'string' } as OutputField).id, 'email')
  assert.equal(inputTypeForField({ name: 'due_date', type: 'string' } as OutputField).id, 'date')
  assert.equal(inputTypeForField({ name: 'payload', type: 'object' } as OutputField).id, 'file')
  assert.equal(inputTypeForField({ name: 'title', type: 'string' } as OutputField).id, 'text')
})

test('inputTypeForField always resolves to a real INPUT_TYPES entry', () => {
  // Every branch ends in a non-null assertion on .find() — if an id ever
  // drifted from the table, that would throw at render time.
  const ids = new Set(INPUT_TYPES.map((type) => type.id))
  for (const type of ['string', 'boolean', 'number', 'object', 'array'] as OutputField['type'][]) {
    const resolved = inputTypeForField({ name: 'x', type } as OutputField)
    assert.ok(resolved && ids.has(resolved.id), `no INPUT_TYPES entry for declared type ${type}`)
  }
})

test('isRecord rejects arrays and null', () => {
  assert.equal(isRecord({ a: 1 }), true)
  assert.equal(isRecord([1]), false)
  assert.equal(isRecord(null), false)
  assert.equal(isRecord('str'), false)
})
