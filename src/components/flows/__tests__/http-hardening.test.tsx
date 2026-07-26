/**
 * WS1 hardening probes for the HTTP node's editor-side guarantees:
 *
 *   1. `Using Fields Below` and `Using JSON` produce the SAME request — the
 *      fields editor serializes rows to the JSON-object string the executor
 *      parses, so the two modes must be interchangeable, tokens included.
 *   2. Everything the editor can write survives the zod graph schema. zod
 *      strips unknown keys on parse, so a UI-only field would be silently
 *      dropped the first time the flow is saved — this test makes that class
 *      of bug impossible.
 *   3. The NDV shows raw input and raw output.
 *   4. A credential that fails verification never attaches without consent.
 */
import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, act, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { parseKeyValueRows, serializeKeyValueRows } from '../nodes/field-primitives'
import { prepareHttpRequest } from '@/features/flows/http'
import { flowGraphSchema, type FlowNode } from '@/lib/flows/graph'
import { NodeDetailView } from '../ndv/node-detail-view'
import { CredentialEditor } from '@/components/credentials/credential-editor'
import { emptyDraft } from '@/lib/credentials/form'
import type { FlowContext } from '@/features/flows/context'

// ── 1. Fields mode ≡ JSON mode ──────────────────────────────────────────────

test('fields-mode rows and hand-written JSON produce identical requests', () => {
  const fromFields = serializeKeyValueRows([
    { key: 'page', value: '2' },
    { key: 'tag', value: 'alpha' },
  ])
  const fromJson = '{"page":"2","tag":"alpha"}'
  const a = prepareHttpRequest({ method: 'GET', url: 'https://api.example.com/x', query: fromFields })
  const b = prepareHttpRequest({ method: 'GET', url: 'https://api.example.com/x', query: fromJson })
  assert.equal(a.url, b.url)

  const headerA = prepareHttpRequest({ method: 'GET', url: 'https://api.example.com/x', headers: fromFields })
  const headerB = prepareHttpRequest({ method: 'GET', url: 'https://api.example.com/x', headers: fromJson })
  assert.deepEqual(headerA.init.headers, headerB.init.headers)
})

test('tokens survive the fields-mode round trip verbatim', () => {
  const rows = [
    { key: 'user', value: '{{step.n1.output.userId}}' },
    { key: 'flag', value: 'literal' },
  ]
  const roundTripped = parseKeyValueRows(serializeKeyValueRows(rows))
  assert.deepEqual(roundTripped, rows)
})

test('a non-string JSON value (number, object) still renders as an editable row', () => {
  // JSON mode may store {"count": 5}; switching to fields mode must not lose it.
  const rows = parseKeyValueRows('{"count": 5, "meta": {"a": 1}}')
  assert.deepEqual(rows, [
    { key: 'count', value: '5' },
    { key: 'meta', value: '{"a":1}' },
  ])
})

// ── 2. Nothing the editor writes is stripped on save ────────────────────────

test('a fully-loaded http config survives the graph schema parse unchanged', () => {
  const data = {
    label: 'Call the API',
    note: 'hardening probe',
    authMode: 'generic' as const,
    credentialType: 'oauth2' as const,
    credentialId: 'cred_1',
    method: 'POST' as const,
    url: 'https://api.example.com/things',
    query: '{"page":"1"}',
    sendQuery: true,
    queryMode: 'fields' as const,
    queryArrayFormat: 'brackets' as const,
    headers: '{"x-a":"1"}',
    sendHeaders: true,
    headersMode: 'json' as const,
    body: '{"a":1}',
    sendBody: true,
    bodyInputMode: 'json' as const,
    bodyMode: 'graphql' as const,
    bodyContentType: 'application/xml',
    graphqlVariables: '{"id":"1"}',
    cookie: 'session=abc',
    responseType: 'json' as const,
    failOnHttpError: false,
    retries: 2,
    retryDelayMs: 250,
    retryStatusCodes: [429, 503],
    timeoutMs: 20_000,
    onError: 'continue' as const,
    followRedirects: true,
    maxRedirects: 5,
    pagination: { mode: 'cursor' as const, cursorParam: 'c', cursorPath: 'next', maxPages: 50, intervalMs: 100, stopPath: 'done' },
    batch: { size: 10, delayMs: 500 },
    excludeFromContext: true,
    disabled: false,
    mockOutput: { ok: true },
  }
  const graph = { nodes: [{ id: 'h1', type: 'http' as const, data }], edges: [] }
  const parsed = flowGraphSchema.parse(graph)
  assert.deepEqual(parsed.nodes[0].data, data)
})

// ── 3. The NDV shows raw input and raw output ───────────────────────────────

const httpNode: FlowNode = { id: 'h1', type: 'http', data: { method: 'GET', url: 'https://x.test' } } as FlowNode

test('the input pane renders raw upstream data and the output pane the last run', (t) => {
  t.after(cleanup)
  const previewContext = {
    trigger: { input: { source: 'webhook' } },
    step: { n1: { output: { userId: 42 } } },
  } as unknown as FlowContext
  const { container } = render(React.createElement(NodeDetailView, {
    node: httpNode, agents: [], toolCatalog: [], dataFields: [], labelCtx: { stepLabels: {} },
    previewContext, lastOutput: { status: 200, body: { hello: 'world' } },
    onChange: () => {}, onClose: () => {},
  }))
  assert.match(container.textContent ?? '', /"userId": 42/, 'raw input JSON is visible')
  assert.match(container.textContent ?? '', /"hello": "world"/, 'raw output JSON is visible')
})

// ── 4. A failing credential never attaches silently ─────────────────────────

test('verification failure keeps the credential detached until Attach anyway', async (t) => {
  t.after(cleanup)
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (url === '/api/credentials') {
      return new Response(JSON.stringify({ credential: { id: 'cred_9', name: 'X', type: 'bearer', allowedDomains: [] } }), { status: 200 })
    }
    if (url.endsWith('/verify')) {
      return new Response(JSON.stringify({ error: 'HTTP 401: nope' }), { status: 400 })
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch

  const attached: string[] = []
  const { container, getByText } = render(React.createElement(CredentialEditor, {
    initial: { ...emptyDraft(), name: 'X', token: 'tok' },
    verifyAgainst: 'https://api.example.com/x',
    context: 'http',
    onSaved: (credential) => { attached.push(credential.id) },
    onCancel: () => {},
  }))
  await act(async () => { fireEvent.click(getByText('Save & verify')) })
  await waitFor(() => {
    assert.match(container.textContent ?? '', /rejected/i, 'the failure banner renders')
  })
  assert.deepEqual(attached, [], 'onSaved must NOT fire on a failed check')

  await act(async () => { fireEvent.click(getByText('Attach anyway')) })
  assert.deepEqual(attached, ['cred_9'], 'explicit consent attaches the saved credential')
})
