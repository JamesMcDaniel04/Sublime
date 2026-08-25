/**
 * Binary data in a flow, as a REFERENCE rather than bytes.
 *
 * Today a binary HTTP response is base64'd and truncated into the run row.
 * Both halves of that are wrong: base64 in a Postgres JSON column bloats every
 * run record, and the truncation means a downloaded PDF is stored corrupt —
 * the flow appears to work and produces a broken file.
 *
 * So bytes go to a blob store and the graph carries a handle. The handle is
 * what a step passes downstream, what a run row records, and what a person
 * eventually downloads.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createBinaryHandle,
  storageKeyFor,
  isBinaryHandle,
  binaryHandlesIn,
  BINARY_MARKER,
} from '../handle'

const org = 'org-1'
const run = 'run-1'

// ── the handle ──────────────────────────────────────────────────────────────

test('a handle describes the file without carrying it', () => {
  const handle = createBinaryHandle({
    organizationId: org, flowRunId: run,
    fileName: 'report.pdf', mimeType: 'application/pdf', size: 120_000,
  })
  assert.equal(handle.fileName, 'report.pdf')
  assert.equal(handle.mimeType, 'application/pdf')
  assert.equal(handle.size, 120_000)
  assert.ok(!JSON.stringify(handle).includes('base64'))
})

test('a handle is recognisable as one', () => {
  const handle = createBinaryHandle({ organizationId: org, flowRunId: run, fileName: 'a.txt', mimeType: 'text/plain', size: 1 })
  assert.equal(isBinaryHandle(handle), true)
  assert.equal(handle[BINARY_MARKER], true)
})

test('ordinary values are not mistaken for handles', () => {
  assert.equal(isBinaryHandle({ fileName: 'a.txt', size: 1 }), false)
  assert.equal(isBinaryHandle('a string'), false)
  assert.equal(isBinaryHandle(null), false)
  assert.equal(isBinaryHandle([]), false)
})

test('two handles never share an id', () => {
  const make = () => createBinaryHandle({ organizationId: org, flowRunId: run, fileName: 'a', mimeType: 'text/plain', size: 1 }).id
  assert.equal(new Set(Array.from({ length: 200 }, make)).size, 200)
})

// ── the storage key ─────────────────────────────────────────────────────────
//
// The security property. A handle travels through a graph and could be
// hand-written into a step's config, so it is UNTRUSTED input by the time it
// reaches a download. The key is therefore derived from the caller's own
// organization, never from anything the handle claims.

test('the key is derived from the caller organization, not the handle', () => {
  const handle = createBinaryHandle({ organizationId: org, flowRunId: run, fileName: 'a', mimeType: 'text/plain', size: 1 })
  assert.match(storageKeyFor('org-2', handle.id), /^org-2\//)
})

test('a key is scoped by organization so ids cannot collide across tenants', () => {
  const id = 'a'.repeat(32)
  assert.notEqual(storageKeyFor('org-1', id), storageKeyFor('org-2', id))
})

// Path traversal in the id would let a crafted handle address another
// workspace's prefix, which is the whole reason the key is derived rather
// than accepted.
test('an id that tries to traverse is refused', () => {
  assert.throws(() => storageKeyFor(org, '../org-2/secret'), /not a valid binary id/i)
  assert.throws(() => storageKeyFor(org, 'a/b'), /not a valid binary id/i)
  assert.throws(() => storageKeyFor(org, ''), /not a valid binary id/i)
  // A well-formed id that is not our shape is refused too, so the key can
  // never contain anything but hex.
  assert.throws(() => storageKeyFor(org, 'A'.repeat(32)), /not a valid binary id/i)
})

test('an organization id that tries to traverse is refused', () => {
  assert.throws(() => storageKeyFor('../elsewhere', 'a'.repeat(32)), /not a valid workspace/i)
  assert.throws(() => storageKeyFor('org/other', 'a'.repeat(32)), /not a valid workspace/i)
})

// ── finding handles in a value ──────────────────────────────────────────────
//
// Needed by retention: when a run is deleted, its blobs must go too, and the
// only record of which blobs a run produced is the handles in its output.

test('handles are found anywhere in a structure', () => {
  const handle = createBinaryHandle({ organizationId: org, flowRunId: run, fileName: 'a', mimeType: 'text/plain', size: 1 })
  const found = binaryHandlesIn({ step: { out: { file: handle } }, list: [handle] })
  assert.equal(found.length, 2)
})

test('a value with no handles yields none', () => {
  assert.deepEqual(binaryHandlesIn({ a: 1, b: 'two', c: [null] }), [])
})

test('scanning tolerates values that are not objects', () => {
  assert.deepEqual(binaryHandlesIn(null), [])
  assert.deepEqual(binaryHandlesIn('text'), [])
  assert.deepEqual(binaryHandlesIn(undefined), [])
})
