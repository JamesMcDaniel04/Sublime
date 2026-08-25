/**
 * The blob store behind binary handles.
 *
 * Two drivers: memory (development and tests) and Supabase Storage
 * (production). A native S3 driver is deliberately absent — S3 needs SigV4
 * request signing, and the same reasoning that kept AWS out of the external
 * secrets work applies here: a store that works sometimes is worse than one
 * that is clearly not implemented. The interface is what makes adding it
 * additive later.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryBinaryStore, MAX_BINARY_BYTES } from '../store'
import { createBinaryHandle } from '../handle'

const org = 'org-1'
const handleFor = (size: number, name = 'a.bin') =>
  createBinaryHandle({ organizationId: org, flowRunId: 'run-1', fileName: name, mimeType: 'application/octet-stream', size })

test('bytes written can be read back exactly', async () => {
  const store = new MemoryBinaryStore()
  const bytes = Buffer.from('hello world')
  const handle = handleFor(bytes.length)
  await store.put(org, handle.id, bytes, 'text/plain')
  assert.deepEqual(await store.get(org, handle.id), bytes)
})

test('a missing blob reads as null rather than throwing', async () => {
  const store = new MemoryBinaryStore()
  assert.equal(await store.get(org, 'b'.repeat(32)), null)
})

// The isolation property. A blob id guessed or forged in another workspace
// must not resolve, because the key is derived from the CALLER's workspace.
test('one workspace cannot read another workspace\'s blob', async () => {
  const store = new MemoryBinaryStore()
  const handle = handleFor(5)
  await store.put(org, handle.id, Buffer.from('secret'), 'text/plain')
  assert.equal(await store.get('org-2', handle.id), null, 'a blob leaked across workspaces')
})

test('deleting removes the bytes', async () => {
  const store = new MemoryBinaryStore()
  const handle = handleFor(5)
  await store.put(org, handle.id, Buffer.from('bye'), 'text/plain')
  await store.delete(org, handle.id)
  assert.equal(await store.get(org, handle.id), null)
})

test('deleting something absent is not an error', async () => {
  const store = new MemoryBinaryStore()
  await store.delete(org, 'c'.repeat(32))
})

// Without a ceiling, one flow downloading a large file exhausts the worker's
// memory and takes every concurrent run down with it.
test('a blob over the ceiling is refused', async () => {
  const store = new MemoryBinaryStore()
  const handle = handleFor(MAX_BINARY_BYTES + 1)
  await assert.rejects(
    () => store.put(org, handle.id, Buffer.alloc(MAX_BINARY_BYTES + 1), 'application/octet-stream'),
    /too large/i,
  )
})

test('a blob at exactly the ceiling is allowed', async () => {
  const store = new MemoryBinaryStore()
  const handle = handleFor(MAX_BINARY_BYTES)
  await store.put(org, handle.id, Buffer.alloc(MAX_BINARY_BYTES), 'application/octet-stream')
  assert.equal((await store.get(org, handle.id))?.length, MAX_BINARY_BYTES)
})

// A forged id must be refused by the store too, not only by the key helper —
// the store is the last thing between a crafted value and the filesystem.
test('an id that is not a valid binary id is refused', async () => {
  const store = new MemoryBinaryStore()
  await assert.rejects(() => store.get(org, '../other/file'), /not a valid/i)
  await assert.rejects(() => store.put(org, 'a/b', Buffer.from('x'), 'text/plain'), /not a valid/i)
})
