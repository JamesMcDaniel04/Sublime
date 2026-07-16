/**
 * Pure helpers for the "What Sublime has learned" transparency view
 * (GET/DELETE /api/intelligence/learnings). Kept separate from
 * connection-scan.ts's DB-touching code so the parsing/labeling logic is
 * trivially unit-testable.
 */

export type ParsedSourceRef = { plane: string; ref: string }

/**
 * Pure: split a stored AgentMemory.sourceRef ("<plane>:<ref>") into its
 * parts. Null for empty/missing/malformed input (no colon, or an empty
 * plane/ref side) — callers should fall back to a generic label. The ref
 * itself may contain colons (e.g. a future composite key), so only the
 * FIRST colon is treated as the separator.
 */
export function parseSourceRef(sourceRef: string | null | undefined): ParsedSourceRef | null {
  if (!sourceRef) return null
  const idx = sourceRef.indexOf(':')
  if (idx <= 0 || idx === sourceRef.length - 1) return null
  return { plane: sourceRef.slice(0, idx), ref: sourceRef.slice(idx + 1) }
}

const PLANE_LABELS: Record<string, string> = {
  mcp: 'MCP server',
  nango: 'Connected account',
}

/** Pure: fallback human label for a plane when no connection-specific name
 *  could be resolved (e.g. the connection was already deleted). */
export function planeLabel(plane: string): string {
  return PLANE_LABELS[plane] ?? 'Connection'
}
