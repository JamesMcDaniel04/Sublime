/**
 * Pure, side-effect-free helpers for the per-connection learning opt-out
 * (Task 4.5): organizations.settings.scanExclusions, an array of
 * `<plane>:<connectionRef>` keys the connection scan must skip.
 *
 * Deliberately has NO imports (not even @/lib/prisma) so client components
 * (the "Learning" toggle on the MCP-server rows) can import
 * it directly without pulling server-only code into the browser bundle.
 * connection-scan.ts re-exports these for its own (server-side) callers.
 */

export const SCAN_PLANES = ['nango', 'mcp', 'postgres'] as const
export type ScanPlane = (typeof SCAN_PLANES)[number]

/** Pure: the stable key identifying one connection across settings, memory
 *  sourceRef, and graph node ids. */
export function connectionSourceRef(plane: ScanPlane, connectionRef: string): string {
  return `${plane}:${connectionRef}`
}

/** Pure: true when `value` is shaped `<plane>:<nonEmptyRef>` for a known scan
 *  plane — the allowed shape for a settings.scanExclusions entry. */
export function isValidScanExclusionEntry(value: string): boolean {
  return SCAN_PLANES.some((plane) => value.startsWith(`${plane}:`) && value.length > plane.length + 1)
}

/** Pure: true when `sourceRef` is listed in the org's per-connection learning
 *  opt-out (settings.scanExclusions). Malformed/missing settings read as "no
 *  exclusions" — same fail-open posture as connection-scan's `scanEnabled`. */
export function isScanExcluded(orgSettings: unknown, sourceRef: string): boolean {
  if (!orgSettings || typeof orgSettings !== 'object' || Array.isArray(orgSettings)) return false
  const exclusions = (orgSettings as Record<string, unknown>).scanExclusions
  return Array.isArray(exclusions) && exclusions.includes(sourceRef)
}

/** Pure: compute the next scanExclusions list after toggling learning for one
 *  connection on/off. Enabling removes the entry; disabling adds it
 *  (deduped). Never mutates `current`. */
export function toggleScanExclusion(current: string[], sourceRef: string, learningEnabled: boolean): string[] {
  if (learningEnabled) return current.filter((ref) => ref !== sourceRef)
  return current.includes(sourceRef) ? current : [...current, sourceRef]
}
