/**
 * Node versioning.
 *
 * The gap this closes: without a version pinned on each node, any breaking
 * change to a node's behaviour either silently changes what existing flows do,
 * or can never be made at all. Both are bad, and the second is why the
 * condition node still carries its legacy `left/op/right` shape alongside
 * `clauses` — there was no way to move flows forward, so the old shape became
 * permanent.
 *
 * The invariant everything here serves: SHIPPING a new node version must never
 * change what an existing flow does. Upgrading is a separate, explicit act.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  nodeVersion,
  latestVersion,
  isOutdated,
  migrateNodeData,
  outdatedNodes,
  migrateGraph,
  LATEST_NODE_VERSIONS,
  type VersionedNode,
} from '../node-versions'

// ── reading a version ───────────────────────────────────────────────────────

// Every node saved before versioning existed is, by definition, version 1.
// Treating an absent version as the LATEST would silently re-interpret every
// existing flow the moment a v2 shipped — the exact failure versioning exists
// to prevent.
test('a node with no version is version 1', () => {
  assert.equal(nodeVersion({ id: 'n1', type: 'condition', data: {} }), 1)
})

test('a pinned version is read as-is', () => {
  assert.equal(nodeVersion({ id: 'n1', type: 'condition', typeVersion: 2, data: {} }), 2)
})

test('a nonsense version falls back to 1 rather than being trusted', () => {
  assert.equal(nodeVersion({ id: 'n1', type: 'condition', typeVersion: 0, data: {} }), 1)
  assert.equal(nodeVersion({ id: 'n1', type: 'condition', typeVersion: -3, data: {} }), 1)
  assert.equal(nodeVersion({ id: 'n1', type: 'condition', typeVersion: 'two' as never, data: {} }), 1)
})

test('a node type with no declared version is version 1', () => {
  assert.equal(latestVersion('stop'), 1)
})

test('the condition node is at version 2', () => {
  assert.equal(latestVersion('condition'), 2)
  assert.equal(LATEST_NODE_VERSIONS.condition, 2)
})

// ── detecting what is behind ────────────────────────────────────────────────

test('an unversioned condition node is outdated', () => {
  assert.equal(isOutdated({ id: 'n1', type: 'condition', data: {} }), true)
})

test('a current node is not outdated', () => {
  assert.equal(isOutdated({ id: 'n1', type: 'condition', typeVersion: 2, data: {} }), false)
})

test('a node type with no versions is never outdated', () => {
  assert.equal(isOutdated({ id: 'n1', type: 'stop', data: {} }), false)
})

// A node pinned AHEAD of what this deployment knows must not be "migrated"
// backwards — that would be a downgrade dressed up as an upgrade, and it
// happens for real during a rollback.
test('a node from a newer deployment is left alone', () => {
  assert.equal(isOutdated({ id: 'n1', type: 'condition', typeVersion: 99, data: {} }), false)
})

test('outdated nodes are reported with their versions', () => {
  const report = outdatedNodes({
    nodes: [
      { id: 'a', type: 'condition', data: { left: '{{x}}', op: 'eq', right: '1' } },
      { id: 'b', type: 'condition', typeVersion: 2, data: { clauses: [] } },
      { id: 'c', type: 'stop', data: {} },
    ],
    edges: [],
  })
  assert.deepEqual(report.map((entry) => entry.id), ['a'])
  assert.equal(report[0].from, 1)
  assert.equal(report[0].to, 2)
})

// ── the condition v1 → v2 migration ─────────────────────────────────────────

test('a legacy condition becomes a single clause', () => {
  const migrated = migrateNodeData('condition', 1, 2, { left: '{{status}}', op: 'eq', right: 'done' })
  assert.deepEqual(migrated.clauses, [{ left: '{{status}}', op: 'eq', right: 'done' }])
  assert.equal(migrated.match, 'all')
})

// The legacy fields must be REMOVED, not left beside the new ones — that is
// the whole point. Leaving them means the back-compat branch can never go.
test('the legacy fields are removed after migrating', () => {
  const migrated = migrateNodeData('condition', 1, 2, { left: '{{status}}', op: 'eq', right: 'done' })
  assert.equal('left' in migrated, false)
  assert.equal('op' in migrated, false)
  assert.equal('right' in migrated, false)
})

test('unrelated fields survive the migration', () => {
  const migrated = migrateNodeData('condition', 1, 2, {
    label: 'Check status', note: 'hi', splitItems: true,
    left: '{{status}}', op: 'eq', right: 'done',
  })
  assert.equal(migrated.label, 'Check status')
  assert.equal(migrated.note, 'hi')
  assert.equal(migrated.splitItems, true)
})

// A v1 node that ALREADY used clauses (both shapes were accepted) must keep
// them — migrating must not discard the richer configuration.
test('existing clauses are preserved rather than overwritten', () => {
  const clauses = [{ left: '{{a}}', op: 'eq', right: '1' }, { left: '{{b}}', op: 'eq', right: '2' }]
  const migrated = migrateNodeData('condition', 1, 2, { clauses, match: 'any', left: '{{x}}', op: 'eq', right: 'y' })
  assert.deepEqual(migrated.clauses, clauses)
  assert.equal(migrated.match, 'any', 'the chosen match mode was overwritten')
})

// An empty legacy condition has nothing to convert. It must not produce a
// clause with empty strings, which would evaluate differently.
test('a condition with nothing configured yields no clauses', () => {
  const migrated = migrateNodeData('condition', 1, 2, {})
  assert.deepEqual(migrated.clauses, [])
})

// ── migrating a graph ───────────────────────────────────────────────────────

test('migrating a graph stamps the new version', () => {
  const { graph, migrated } = migrateGraph({
    nodes: [{ id: 'a', type: 'condition', data: { left: '{{x}}', op: 'eq', right: '1' } }] as VersionedNode[],
    edges: [],
  })
  assert.equal(migrated.length, 1)
  assert.equal(graph.nodes[0].typeVersion, 2)
  assert.deepEqual(graph.nodes[0].data.clauses, [{ left: '{{x}}', op: 'eq', right: '1' }])
})

test('a graph with nothing outdated is returned unchanged', () => {
  const original = { nodes: [{ id: 'a', type: 'stop', data: {} }], edges: [] }
  const { graph, migrated } = migrateGraph(original)
  assert.equal(migrated.length, 0)
  assert.deepEqual(graph, original)
})

test('migrating is idempotent', () => {
  const first = migrateGraph({ nodes: [{ id: 'a', type: 'condition', data: { left: '{{x}}', op: 'eq', right: '1' } }], edges: [] })
  const second = migrateGraph(first.graph)
  assert.equal(second.migrated.length, 0)
  assert.deepEqual(second.graph, first.graph)
})

test('edges and other graph fields are untouched', () => {
  const { graph } = migrateGraph({
    nodes: [{ id: 'a', type: 'condition', data: { left: '{{x}}', op: 'eq', right: '1' } }],
    edges: [{ id: 'e0', source: 'a', target: 'b' }],
  })
  assert.deepEqual(graph.edges, [{ id: 'e0', source: 'a', target: 'b' }])
})

// ── newly added nodes ───────────────────────────────────────────────────────
//
// A node added today is authored against today's behaviour. If it were born
// unversioned it would fall under the absent-means-1 rule and immediately
// report itself as outdated — the builder would offer to migrate a node it
// had just created.

test('a newly added node is born at the current version', async () => {
  const { insertNodeAfter } = await import('../mutate')
  const graph = {
    nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } }],
    edges: [],
  }
  const next = insertNodeAfter(graph as never, 'trigger', 'condition')
  const added = (next.graph.nodes as VersionedNode[]).find((node) => node.type === 'condition')
  assert.ok(added, 'no condition node was added')
  assert.equal(nodeVersion(added), 2)
  assert.equal(isOutdated(added), false, 'a freshly added node reported itself as outdated')
})
