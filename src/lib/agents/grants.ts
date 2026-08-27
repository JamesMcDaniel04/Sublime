/**
 * An agent's own permission grant — what it may DO, independent of whose
 * credentials it runs with.
 *
 * Until this existed an agent inherited its owner's access wholesale: every
 * tool on every plane the owner's connections reached. That is the sentence
 * that ends an enterprise deal ("the agent can do anything its owner can").
 * A grant scopes the agent per plane to read, write, or nothing, and the
 * runtime enforces it where it matters — a tool the grant forbids is never
 * offered to the model, so there is nothing to prompt-inject toward.
 *
 * Shape: { [plane]: 'read' | 'write' | 'blocked' } with '*' as the wildcard.
 * `null` on the row means a LEGACY agent — unrestricted, exactly its
 * behaviour before grants existed, so shipping this changed nothing for any
 * agent that already ran. New agents default to read-only until a human
 * widens them. Every unknown is resolved fail-closed: a malformed grant
 * reads as read-only, an unlisted plane on an explicit grant reads as
 * read-only, a tool nobody can classify reads as a write.
 *
 * Pure and dependency-free so it runs on the server and in the browser and
 * unit-tests without a database.
 */

export const GRANT_LEVELS = ['read', 'write', 'blocked'] as const
export type GrantLevel = (typeof GRANT_LEVELS)[number]
export type AgentGrants = Record<string, GrantLevel>

export const WILDCARD = '*'
/** A human built it and will widen it deliberately. */
export const DEFAULT_NEW_AGENT_GRANTS: AgentGrants = { [WILDCARD]: 'read' }
/** What a legacy (null) row is equivalent to. */
export const UNRESTRICTED_GRANTS: AgentGrants = { [WILDCARD]: 'write' }

/** Planes people name differently from the runtime: a grant on one applies to the other. */
const PLANE_ALIASES: Record<string, string[]> = { gmail: ['email'], email: ['gmail'] }

/**
 * Planes that write to Sublime's OWN ledgers rather than to an external
 * system — logging work against a goal, for instance. A grant exists to
 * bound what an agent can do to the outside world; withholding an agent's
 * ability to record its own work inside the workspace would only blind the
 * measurement spine, so these are never gated.
 */
const INTERNAL_PLANES: ReadonlySet<string> = new Set(['sublime-goals'])
export const isInternalPlane = (provider: string): boolean => INTERNAL_PLANES.has(provider.trim().toLowerCase())

/** Validate a stored/submitted grant. Null stays null (legacy); junk fails closed. */
export function parseGrants(value: unknown): AgentGrants | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_NEW_AGENT_GRANTS }
  const out: AgentGrants = {}
  for (const [key, level] of Object.entries(value as Record<string, unknown>)) {
    const k = key.trim().toLowerCase()
    if (k && (GRANT_LEVELS as readonly string[]).includes(String(level))) out[k] = level as GrantLevel
  }
  return out
}

/**
 * The level that applies to a runtime provider id.
 *
 * Lookup order, most specific first: the exact provider ('nango:slack',
 * 'postgres:write'), the id with its transport prefix stripped ('slack'),
 * the plane family ('postgres'), a declared alias, then the wildcard. An
 * explicit grant with no wildcard leaves unlisted planes read-only.
 */
export function grantFor(grants: AgentGrants | null, provider: string): GrantLevel {
  if (grants === null) return 'write'
  const id = provider.trim().toLowerCase()
  if (INTERNAL_PLANES.has(id)) return 'write'
  const candidates = [id, id.replace(/^nango:/, ''), id.split(':')[0]]
  for (const candidate of candidates) if (candidate in grants) return grants[candidate]
  for (const candidate of candidates) {
    for (const alias of PLANE_ALIASES[candidate] ?? []) if (alias in grants) return grants[alias]
  }
  return grants[WILDCARD] ?? 'read'
}

export type ToolKind = 'read' | 'write'

// Verb tables for tools that carry no MCP annotations. A write verb anywhere
// in the name wins over a read verb ("get_or_create_channel" creates), and a
// name with neither is a write — the cost of hiding a harmless tool from a
// read-only agent is a weaker answer; the cost of exposing a harmful one is
// the whole point of the grant.
const WRITE_VERB = /(^|[_\-.])(send|create|update|delete|post|write|set|remove|add|insert|upsert|publish|execute|run|trigger|reply|invite|archive|move|assign|edit|patch|put|upload|import|schedule|cancel|approve|reject|merge|close|open|start|stop|deploy|notify|mark|complete|submit|share|revoke|grant|kick|ban|pin|react|log)([_\-.]|$)/i
const READ_VERB = /(^|[_\-.])(get|list|search|read|find|fetch|query|describe|show|lookup|retrieve|count|check|view|preview|export|download|summari[sz]e|history|status|info)([_\-.]|$)/i

/**
 * Whether a tool reads or writes. MCP annotations are authoritative when a
 * server sends them; a plane the registry declares read-only (Granola) is
 * read; otherwise the name decides, defaulting to write.
 */
export function classifyTool(tool: {
  name: string
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } | null
  /** The plane is declared read-only by the connector registry. */
  planeIsReadOnly?: boolean
}): ToolKind {
  if (tool.annotations?.readOnlyHint === true) return 'read'
  if (tool.annotations?.destructiveHint === true) return 'write'
  if (tool.planeIsReadOnly) return 'read'
  if (WRITE_VERB.test(tool.name)) return 'write'
  if (READ_VERB.test(tool.name)) return 'read'
  return 'write'
}

export function toolAllowed(level: GrantLevel, kind: ToolKind): boolean {
  if (level === 'blocked') return false
  if (level === 'read') return kind === 'read'
  return true
}

/**
 * The grant a template or import provisions with: write on every plane the
 * spec declared (the author declared them because the agent writes to them),
 * read on everything else. A provisioned agent still cannot reach a plane its
 * spec never mentioned.
 */
export function provisionedGrants(integrations: string[]): AgentGrants {
  const grants: AgentGrants = { ...DEFAULT_NEW_AGENT_GRANTS }
  for (const raw of integrations) {
    const key = raw.trim().toLowerCase()
    if (key) grants[key] = 'write'
  }
  return grants
}
