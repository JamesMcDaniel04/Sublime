/**
 * Turning a flow into a file that belongs in a git repository.
 *
 * The property that makes this worth doing: pushing an UNCHANGED flow must
 * produce byte-identical content. Without that, every push writes a diff, and
 * a diff that always appears is a diff nobody reads — which defeats the entire
 * purpose of putting flows under review.
 *
 * That rules out the obvious implementation. The existing export path stamps
 * an `exportedAt` timestamp, which alone would guarantee a spurious change on
 * every single push.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowFileContent, flowFilePath, flowIdFromFile, canonicalJson } from '../flow-file'

const flow = {
  id: 'clx123abc',
  name: 'Nightly Sync',
  description: 'Syncs things',
  trigger: { type: 'schedule', cron: '0 2 * * *' },
  graph: {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'schedule' } } },
      { id: 'call', type: 'http', typeVersion: 1, data: { url: 'https://api.example.com', method: 'GET' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'call' }],
  },
}

// ── canonical JSON ──────────────────────────────────────────────────────────

test('object keys are ordered regardless of how they were built', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }))
})

test('canonical ordering reaches nested objects', () => {
  assert.equal(
    canonicalJson({ outer: { z: 1, a: { y: 2, b: 3 } } }),
    canonicalJson({ outer: { a: { b: 3, y: 2 }, z: 1 } }),
  )
})

// Array order is DATA — reordering the nodes of a graph changes the graph.
// Sorting them would silently discard meaning.
test('array order is preserved, not sorted', () => {
  assert.notEqual(canonicalJson([1, 2, 3]), canonicalJson([3, 2, 1]))
})

test('the output is human-readable, since a human reviews it', () => {
  assert.match(canonicalJson({ a: 1 }), /\n/)
})

test('the file ends with a newline, as a text file should', () => {
  assert.match(flowFileContent(flow), /\n$/)
})

// ── determinism ─────────────────────────────────────────────────────────────

// The load-bearing property.
test('serializing the same flow twice yields identical bytes', () => {
  assert.equal(flowFileContent(flow), flowFileContent(flow))
})

test('serializing an equivalent flow built in a different key order matches', () => {
  const reordered = {
    graph: {
      edges: [{ target: 'call', source: 'trigger', id: 'e0' }],
      nodes: [
        { data: { trigger: { type: 'schedule' } }, type: 'trigger', id: 'trigger' },
        { data: { method: 'GET', url: 'https://api.example.com' }, typeVersion: 1, type: 'http', id: 'call' },
      ],
    },
    trigger: { cron: '0 2 * * *', type: 'schedule' },
    description: 'Syncs things',
    name: 'Nightly Sync',
    id: 'clx123abc',
  }
  assert.equal(flowFileContent(reordered), flowFileContent(flow))
})

// The failure this whole design exists to avoid.
test('no timestamp or other volatile field reaches the file', () => {
  const content = flowFileContent(flow)
  assert.doesNotMatch(content, /exportedAt/i)
  assert.doesNotMatch(content, /updatedAt/i)
  assert.doesNotMatch(content, /createdAt/i)
  // An ISO date anywhere in the document would reintroduce the problem.
  assert.doesNotMatch(content, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
})

test('a real change does produce a different file', () => {
  const changed = { ...flow, name: 'Nightly Sync v2' }
  assert.notEqual(flowFileContent(changed), flowFileContent(flow))
})

test('a graph change produces a different file', () => {
  const changed = { ...flow, graph: { ...flow.graph, edges: [] } }
  assert.notEqual(flowFileContent(changed), flowFileContent(flow))
})

// ── secrets ─────────────────────────────────────────────────────────────────

// A repository is the single easiest place to leak a credential, and unlike a
// database row it is copied to every clone forever.
test('a credential-shaped value never reaches the file', () => {
  const risky = {
    ...flow,
    graph: {
      ...flow.graph,
      nodes: [
        ...flow.graph.nodes,
        {
          id: 'leak', type: 'http', data: {
            url: 'https://api.example.com',
            headers: JSON.stringify({ authorization: 'Bearer sk-live-SECRET-VALUE' }),
            credentialId: 'cred_123',
          },
        },
      ],
    },
  }
  const content = flowFileContent(risky)
  assert.doesNotMatch(content, /sk-live-SECRET-VALUE/)
})

// The real webhook secret fields, as lib/flows/trigger.ts stores them.
test('the stored webhook secret never reaches the file', () => {
  const content = flowFileContent({
    ...flow,
    trigger: { type: 'webhook', webhookSecretHash: 'HASHVALUE', webhookSecretEnc: 'CIPHERTEXT' },
  })
  assert.doesNotMatch(content, /HASHVALUE/)
  assert.doesNotMatch(content, /CIPHERTEXT/)
})

// Defense in depth. No trigger type stores a bare `secret`/`token` today, so
// nothing depends on this — but a repository is the worst place in the system
// to leak a credential (every clone, forever), and a future trigger field
// would otherwise ship silently on the next push.
test('a credential-shaped trigger field is stripped even though none exists today', () => {
  const content = flowFileContent({
    ...flow,
    trigger: { type: 'webhook', secret: 'whsec_SECRET', apiToken: 'tok_SECRET', password: 'pw_SECRET' },
  })
  assert.doesNotMatch(content, /whsec_SECRET/)
  assert.doesNotMatch(content, /tok_SECRET/)
  assert.doesNotMatch(content, /pw_SECRET/)
})

// The trade stated as a test: this strips more than it must, on purpose.
// A stripped non-secret is noticed and reported; a leaked credential in a git
// history is neither.
test('an over-eager match is accepted rather than risking a leak', () => {
  const content = flowFileContent({ ...flow, trigger: { type: 'webhook', tokenPath: 'body.id' } })
  assert.doesNotMatch(content, /tokenPath/)
})

// ...without stripping the fields that make a trigger a trigger.
test('ordinary trigger configuration survives', () => {
  const content = flowFileContent({ ...flow, trigger: { type: 'schedule', cron: '0 2 * * *', timezone: 'UTC' } })
  assert.match(content, /0 2 \* \* \*/)
  assert.match(content, /UTC/)
})

// ── paths and identity ──────────────────────────────────────────────────────

test('the path is readable and unique', () => {
  const path = flowFilePath(flow)
  assert.match(path, /^flows\//)
  assert.match(path, /nightly-sync/)
  assert.match(path, /clx123abc/)
  assert.match(path, /\.json$/)
})

test('a name with awkward characters still yields a safe path', () => {
  const path = flowFilePath({ ...flow, name: 'Weird/Name: With\\Stuff?? *' })
  assert.doesNotMatch(path.slice('flows/'.length), /[/\\:*?"<>|]/)
  assert.match(path, /clx123abc/)
})

test('an empty name still yields a usable path', () => {
  assert.match(flowFilePath({ ...flow, name: '   ' }), /^flows\/clx123abc\.json$/)
})

// Identity lives INSIDE the file, not in its name. So renaming a flow — which
// changes the path — never makes a pull think it is a different flow.
test('the flow id is recovered from the file content, not the path', () => {
  const content = flowFileContent(flow)
  assert.equal(flowIdFromFile(content), 'clx123abc')
})

test('a renamed flow is still recognised as the same flow', () => {
  const renamed = { ...flow, name: 'Completely Different Name' }
  assert.notEqual(flowFilePath(renamed), flowFilePath(flow))
  assert.equal(flowIdFromFile(flowFileContent(renamed)), flowIdFromFile(flowFileContent(flow)))
})

test('a file that is not one of ours yields no id', () => {
  assert.equal(flowIdFromFile('{"hello":"world"}'), null)
  assert.equal(flowIdFromFile('not json at all'), null)
  assert.equal(flowIdFromFile(''), null)
})
