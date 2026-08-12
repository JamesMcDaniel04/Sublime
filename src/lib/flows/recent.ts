/**
 * Selection logic for the Home "Pick up where you left off" strip.
 * Pure (no React, no fetch) so it is directly unit-testable.
 */

/** The slice of the /api/flows list payload the Home strip reads. */
export type RecentFlowInput = {
  id: string
  name: string
  status: string
  updatedAt: string
  suggested?: boolean
}

/** Cards shown on the Home strip. */
export const RECENT_FLOWS_LIMIT = 3

/**
 * The most recently updated flows, excluding AI-suggested drafts — those are
 * Sublime's proposals, not flows the user worked on, and they already have a
 * dedicated rail on the Flows page. Relies on the API's `updatedAt desc`
 * ordering instead of re-sorting.
 */
export function pickRecentFlows<T extends RecentFlowInput>(flows: T[] | undefined | null): T[] {
  if (!Array.isArray(flows)) return []
  return flows
    .filter((flow) => !(flow.suggested && flow.status === 'draft'))
    .slice(0, RECENT_FLOWS_LIMIT)
}
