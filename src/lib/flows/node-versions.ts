/**
 * Node versioning and breaking-change migrations.
 *
 * Without a version pinned per node, a breaking change to a node's behaviour
 * has only two possible outcomes, and both are bad: silently change what every
 * existing flow does, or never make the change at all. The second is why the
 * condition node still carries its legacy `left`/`op`/`right` shape next to
 * `clauses` — there was no way to move existing flows forward, so the old
 * shape became permanent.
 *
 * **The invariant.** Shipping a new node version must NEVER change what an
 * existing flow does. A saved node keeps the version it was authored at, the
 * interpreter honours that version, and upgrading is a separate, explicit,
 * reviewable act. Everything below follows from that.
 */

export interface VersionedNode {
  id: string
  type: string
  typeVersion?: number
  data: Record<string, unknown>
  [key: string]: unknown
}

export interface VersionedGraph {
  nodes: VersionedNode[]
  edges: unknown[]
  [key: string]: unknown
}

/**
 * The current version of each node type.
 *
 * A type absent from this map is at version 1 and has never had a breaking
 * change. Only add an entry when you are actually shipping one.
 */
export const LATEST_NODE_VERSIONS: Record<string, number> = {
  // v2 replaces the single left/op/right comparison with a `clauses` list.
  condition: 2,
}

export function latestVersion(type: string): number {
  return LATEST_NODE_VERSIONS[type] ?? 1
}

/**
 * The version a saved node was authored at.
 *
 * An absent version means 1 — every node saved before versioning existed.
 * Reading it as the LATEST instead would silently re-interpret every existing
 * flow the moment a v2 shipped, which is precisely the failure this mechanism
 * exists to prevent. Anything malformed is also 1: the oldest behaviour is the
 * one the flow was built against, so it is the safe answer.
 */
export function nodeVersion(node: { typeVersion?: unknown } & Record<string, unknown>): number {
  const version = node.typeVersion
  return typeof version === 'number' && Number.isInteger(version) && version >= 1 ? version : 1
}

/**
 * Whether a node is behind the current version.
 *
 * A node pinned AHEAD of what this deployment knows is NOT outdated. That
 * happens for real during a rollback, and "migrating" it would be a downgrade
 * wearing an upgrade's clothes.
 */
export function isOutdated(node: VersionedNode): boolean {
  return nodeVersion(node) < latestVersion(node.type)
}

type Migration = (data: Record<string, unknown>) => Record<string, unknown>

/**
 * How to move a node's config from one version to the next.
 *
 * Keyed by type, then by the version being migrated FROM. Steps are applied in
 * sequence, so a v1 node reaching v3 runs 1→2 then 2→3 — each migration only
 * ever has to know about one hop.
 */
const MIGRATIONS: Record<string, Record<number, Migration>> = {
  condition: {
    /**
     * v1 → v2: fold the single left/op/right comparison into `clauses`.
     *
     * The legacy keys are DELETED rather than left alongside. Leaving them is
     * what made the old shape permanent in the first place — while both exist,
     * the evaluator has to keep supporting both.
     */
    1: (data) => {
      const { left, op, right, ...rest } = data
      const existing = Array.isArray(data.clauses) ? data.clauses : []

      // A node that already used clauses keeps them: both shapes were accepted
      // at v1, and overwriting the richer one with a single legacy comparison
      // would lose configuration.
      if (existing.length > 0) {
        return { ...rest, clauses: existing, match: data.match ?? 'all' }
      }

      // Mirrors evalCondition's OWN rule for building a legacy clause:
      //   left !== undefined && op && right !== undefined
      //
      // Anything looser changes behaviour on half-configured nodes, which are
      // common in a real workspace. Defaulting a missing `right` to '' looks
      // harmless and is not: the legacy evaluator refuses to build a clause at
      // all and answers false, while a clause of `{{empty}} eq ''` answers
      // true — silently sending the flow down the other branch.
      const clauses = left !== undefined && op && right !== undefined
        ? [{ left, op, right }]
        : []

      return { ...rest, clauses, match: data.match ?? 'all' }
    },
  },
}

/**
 * Migrate one node's config from `from` up to `to`.
 *
 * A missing step is not an error: a version bump can be behavioural rather
 * than structural (the interpreter branches on the version, the config shape
 * is unchanged), and those need no data migration at all.
 */
export function migrateNodeData(
  type: string,
  from: number,
  to: number,
  data: Record<string, unknown>,
): Record<string, unknown> {
  let current = { ...data }
  for (let version = from; version < to; version++) {
    const step = MIGRATIONS[type]?.[version]
    if (step) current = step(current)
  }
  return current
}

export interface OutdatedNode {
  id: string
  type: string
  from: number
  to: number
}

/** Every node in a graph that is behind, with the versions involved. */
export function outdatedNodes(graph: { nodes?: unknown; [key: string]: unknown }): OutdatedNode[] {
  const nodes = Array.isArray(graph.nodes) ? (graph.nodes as VersionedNode[]) : []
  return nodes.filter(isOutdated).map((node) => ({
    id: node.id,
    type: node.type,
    from: nodeVersion(node),
    to: latestVersion(node.type),
  }))
}

/**
 * Migrate a whole graph, reporting what changed.
 *
 * Returns a NEW graph rather than mutating: the caller decides whether to
 * persist the result, which is what keeps an upgrade an explicit act rather
 * than a side effect of opening a flow.
 *
 * A graph with nothing outdated is returned untouched, so this is safe to call
 * unconditionally and idempotent when called twice.
 */
export function migrateGraph<T extends { nodes?: unknown; [key: string]: unknown }>(graph: T): { graph: T; migrated: OutdatedNode[] } {
  const migrated = outdatedNodes(graph)
  if (migrated.length === 0) return { graph, migrated }

  const byId = new Map(migrated.map((entry) => [entry.id, entry]))
  const nodes = (graph.nodes as VersionedNode[]).map((node) => {
    const entry = byId.get(node.id)
    if (!entry) return node
    return {
      ...node,
      typeVersion: entry.to,
      data: migrateNodeData(node.type, entry.from, entry.to, node.data ?? {}),
    }
  })

  return { graph: { ...graph, nodes } as T, migrated }
}
