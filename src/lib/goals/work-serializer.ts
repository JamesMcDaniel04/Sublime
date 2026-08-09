/**
 * What an assignee who is NOT a goal member may see of their own work item.
 *
 * A GoalWork row is a side channel into a goal you cannot see, so this is the
 * only path by which a non-member reads a restricted goal's work — and it is
 * the most delicate part of the restriction design.
 *
 * ALLOW-LIST, not a deny-list. A newly added GoalWork column is excluded until
 * someone consciously includes it, so the default for new data is "not leaked".
 * A deny-list would leak every future column until somebody remembered.
 *
 * `signals` is the field that makes this necessary: free-form JSON the agent
 * used to PICK this subject, which reveals what the goal is about more directly
 * than the goal's own name would.
 */

import type { GoalWork } from '@/generated/prisma/client'

export const ANONYMISED_WORK_KEYS = [
  'id',
  'subject',
  'body',
  'bodyFormat',
  'produced',
  'disposition',
  'outcome',
  'createdAt',
] as const

export type AnonymisedWork = Pick<GoalWork, (typeof ANONYMISED_WORK_KEYS)[number]>

export function serializeWorkForNonMember(work: GoalWork): AnonymisedWork {
  // Built by PICKING from the allow-list rather than deleting from the row, so
  // a new column cannot arrive already-included.
  const output = {} as Record<string, unknown>
  for (const key of ANONYMISED_WORK_KEYS) output[key] = work[key]
  return output as AnonymisedWork
}
