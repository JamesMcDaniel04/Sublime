import { test } from 'node:test'
import assert from 'node:assert/strict'
import { performHttpRequest, prepareHttpRequest } from '../http'

// A fetch stub driven by a queue of responses; records every requested URL.
function fetchQueue(responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const urls: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(String(input))
    const next = responses.shift() ?? { status: 200, body: {} }
    const body = typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {})
    return new Response(body, {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    })
  }
  return { urls, fetchImpl }
}

const guardCalls: string[] = []
const deps = (fetchImpl: typeof fetch, sleeps?: number[]) => ({
  fetchImpl,
  assertUrlAllowed: async (url: string) => {
    guardCalls.push(url)
  },
  sleep: async (ms: number) => {
    sleeps?.push(ms)
  },
})

test('performHttpRequest returns the response envelope for a single request', async () => {
  const { fetchImpl } = fetchQueue([{ status: 200, body: { hello: 'world' } }])
  const request = prepareHttpRequest({ method: 'GET', url: 'https://api.example.com/things' })
  const output = await performHttpRequest(request, {}, deps(fetchImpl))
  assert.deepEqual((output as { body: unknown }).body, { hello: 'world' })
})

test('performHttpRequest blocks redirects unless followRedirects is on', async () => {
  const { fetchImpl } = fetchQueue([{ status: 302, headers: { location: 'https://elsewhere.example.com' } }])
  const request = prepareHttpRequest({ method: 'GET', url: 'https://api.example.com' })
  await assert.rejects(performHttpRequest(request, {}, deps(fetchImpl)), /redirect blocked/)
})

test('performHttpRequest follows redirects and re-checks the SSRF guard per hop', async () => {
  guardCalls.length = 0
  const { fetchImpl, urls } = fetchQueue([
    { status: 302, headers: { location: 'https://next.example.com/step2' } },
    { status: 200, body: { done: true } },
  ])
  const request = prepareHttpRequest({ method: 'GET', url: 'https://api.example.com', followRedirects: true })
  const output = await performHttpRequest(request, {}, deps(fetchImpl))
  assert.deepEqual((output as { body: unknown }).body, { done: true })
  assert.deepEqual(urls, ['https://api.example.com', 'https://next.example.com/step2'])
  assert.deepEqual(guardCalls, urls)
})

test('performHttpRequest enforces the redirect limit', async () => {
  const { fetchImpl } = fetchQueue([
    { status: 302, headers: { location: 'https://a.example.com' } },
    { status: 302, headers: { location: 'https://b.example.com' } },
  ])
  const request = prepareHttpRequest({ method: 'GET', url: 'https://api.example.com', followRedirects: true, maxRedirects: 1 })
  await assert.rejects(performHttpRequest(request, {}, deps(fetchImpl)), /redirect limit/)
})

test('performHttpRequest throws on configured retry status codes', async () => {
  const { fetchImpl } = fetchQueue([{ status: 429, body: { slow: true } }])
  const request = prepareHttpRequest({ method: 'GET', url: 'https://api.example.com', failOnHttpError: false })
  await assert.rejects(performHttpRequest(request, { retryStatusCodes: [429] }, deps(fetchImpl)), /HTTP 429/)
})

test('performHttpRequest surfaces HTTP errors unless failOnHttpError is off', async () => {
  const failing = fetchQueue([{ status: 500, body: { err: 1 } }])
  const request = prepareHttpRequest({ method: 'GET', url: 'https://api.example.com' })
  await assert.rejects(performHttpRequest(request, {}, deps(failing.fetchImpl)), /HTTP 500/)

  const tolerated = fetchQueue([{ status: 500, body: { err: 1 } }])
  const lenient = prepareHttpRequest({ method: 'GET', url: 'https://api.example.com', failOnHttpError: false })
  const output = await performHttpRequest(lenient, {}, deps(tolerated.fetchImpl))
  assert.equal((output as { status: number }).status, 500)
})

test('page-mode pagination aggregates pages until an empty page', async () => {
  const { fetchImpl, urls } = fetchQueue([
    { body: [1, 2] },
    { body: [3] },
    { body: [] },
  ])
  const request = prepareHttpRequest({ method: 'GET', url: 'https://api.example.com/items' })
  const output = await performHttpRequest(request, { pagination: { mode: 'page', pageParam: 'p', startPage: 1 } }, deps(fetchImpl))
  assert.deepEqual(output, { ok: true, pages: [[1, 2], [3], []], pageCount: 3 })
  assert.deepEqual(urls, [
    'https://api.example.com/items?p=1',
    'https://api.example.com/items?p=2',
    'https://api.example.com/items?p=3',
  ])
})

test('cursor-mode pagination threads the cursor until it disappears', async () => {
  const { fetchImpl, urls } = fetchQueue([
    { body: { items: [1], nextCursor: 'abc' } },
    { body: { items: [2] } },
  ])
  const request = prepareHttpRequest({ method: 'GET', url: 'https://api.example.com/items' })
  const output = await performHttpRequest(request, { pagination: { mode: 'cursor', cursorParam: 'cursor', cursorPath: 'nextCursor' } }, deps(fetchImpl))
  assert.equal((output as { pageCount: number }).pageCount, 2)
  assert.deepEqual(urls, ['https://api.example.com/items', 'https://api.example.com/items?cursor=abc'])
})

test('nextUrl-mode pagination follows the next link', async () => {
  const { fetchImpl, urls } = fetchQueue([
    { body: { items: [1], next: 'https://api.example.com/items?page=2' } },
    { body: { items: [2] } },
  ])
  const request = prepareHttpRequest({ method: 'GET', url: 'https://api.example.com/items' })
  const output = await performHttpRequest(request, { pagination: { mode: 'nextUrl', nextUrlPath: 'next' } }, deps(fetchImpl))
  assert.equal((output as { pageCount: number }).pageCount, 2)
  assert.deepEqual(urls, ['https://api.example.com/items', 'https://api.example.com/items?page=2'])
})

test('pagination intervalMs sleeps between page requests but not before the first', async () => {
  const { fetchImpl } = fetchQueue([{ body: [1] }, { body: [2] }, { body: [] }])
  const sleeps: number[] = []
  const request = prepareHttpRequest({ method: 'GET', url: 'https://api.example.com/items' })
  await performHttpRequest(request, { pagination: { mode: 'page', intervalMs: 250 } }, deps(fetchImpl, sleeps))
  assert.deepEqual(sleeps, [250, 250])
})

test('pagination stopPath ends pagination when the path is truthy', async () => {
  const { fetchImpl, urls } = fetchQueue([
    { body: { items: [1], meta: { last: false } } },
    { body: { items: [2], meta: { last: true } } },
    { body: { items: [3] } },
  ])
  const request = prepareHttpRequest({ method: 'GET', url: 'https://api.example.com/items' })
  const output = await performHttpRequest(request, { pagination: { mode: 'page', stopPath: 'meta.last' } }, deps(fetchImpl))
  assert.equal((output as { pageCount: number }).pageCount, 2)
  assert.equal(urls.length, 2)
})

test('batch throttling sleeps after every batch of paginated requests', async () => {
  const { fetchImpl } = fetchQueue([{ body: [1] }, { body: [2] }, { body: [3] }, { body: [] }])
  const sleeps: number[] = []
  const request = prepareHttpRequest({ method: 'GET', url: 'https://api.example.com/items' })
  await performHttpRequest(
    request,
    { pagination: { mode: 'page' }, batch: { size: 2, delayMs: 500 } },
    deps(fetchImpl, sleeps),
  )
  // 4 requests in batches of 2 → one pause after request 2, one after request 4… but
  // the final batch boundary needs no pause since pagination ended. Expect one sleep.
  assert.deepEqual(sleeps, [500])
})
