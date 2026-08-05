import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchImportDocument, MAX_IMPORT_BYTES } from '../fetch-url'

const jsonResponse = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, ...init })

test('rejects http:// URLs without fetching', async () => {
  let called = false
  await assert.rejects(
    fetchImportDocument('http://example.com/flow.json', (async () => { called = true; return jsonResponse('{}') }) as typeof fetch),
  )
  assert.equal(called, false)
})

test('rejects private addresses without fetching', async () => {
  let called = false
  await assert.rejects(
    fetchImportDocument('https://127.0.0.1/flow.json', (async () => { called = true; return jsonResponse('{}') }) as typeof fetch),
  )
  assert.equal(called, false)
})

test('returns the body for an allowed URL', async () => {
  const text = await fetchImportDocument(
    'https://example.com/flow.json',
    (async () => jsonResponse('{"format":"sublime.flow"}')) as typeof fetch,
  )
  assert.equal(text, '{"format":"sublime.flow"}')
})

test('follows one redirect and re-validates the hop', async () => {
  const calls: string[] = []
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url === 'https://example.com/a') {
      return new Response(null, { status: 302, headers: { location: 'https://example.com/b' } })
    }
    return jsonResponse('done')
  }) as typeof fetch
  const text = await fetchImportDocument('https://example.com/a', impl)
  assert.equal(text, 'done')
  assert.deepEqual(calls, ['https://example.com/a', 'https://example.com/b'])
})

test('rejects a redirect to a private address', async () => {
  const impl = (async (input: RequestInfo | URL) => {
    if (String(input) === 'https://example.com/a') {
      return new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest' } })
    }
    return jsonResponse('should never arrive')
  }) as typeof fetch
  await assert.rejects(fetchImportDocument('https://example.com/a', impl))
})

test('rejects an oversized response', async () => {
  const impl = (async () => jsonResponse('x'.repeat(MAX_IMPORT_BYTES + 1))) as typeof fetch
  await assert.rejects(fetchImportDocument('https://example.com/big.json', impl), /too large/i)
})

test('rejects a non-2xx response', async () => {
  const impl = (async () => new Response('nope', { status: 404 })) as typeof fetch
  await assert.rejects(fetchImportDocument('https://example.com/missing.json', impl), /404/)
})
