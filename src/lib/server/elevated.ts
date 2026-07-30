/**
 * Audited cross-owner access for workspace admins.
 *
 * Admins may read, edit, delete and reassign any resource in their workspace —
 * but ELEVATED, never AMBIENT. Default list queries stay owner/visibility
 * scoped (see visibility.ts), so an admin's own flow list shows their flows,
 * not all forty in the org. Reaching another member's work is an explicit act:
 * an admin surface, or an opt-in ?scope=workspace.
 *
 * Two reasons that distinction matters:
 *
 *   1. An admin's workspace stays usable instead of flooded with other
 *      people's drafts.
 *   2. The audit log stays meaningful. Every entry is a deliberate act rather
 *      than incidental list traffic — which is what makes the log worth
 *      reading during an incident.
 *
 * The capability check and the audit write live in the SAME function on
 * purpose: the only code path that grants cross-owner access is the one that
 * records it, so "read someone's private flow without leaving a trace" is not
 * expressible through this API.
 */

import { recordAudit } from '@/lib/audit'
import { ApiError } from './api-handler'
import { can } from './permissions'
import type { AuthContext } from './auth'

/**
 * Cross-owner actions, spelled once so the audit log has a stable vocabulary.
 *
 * A runtime array rather than a bare union (mirroring CAPABILITIES in
 * permissions.ts) so the vocabulary is enumerable and therefore testable: a
 * closed set nobody can iterate quietly accumulates entries that nothing ever
 * writes, which is how member.role.change, member.deactivate and
 * admin.resource.delete came to sit here unused.
 *
 * Scope is deliberately narrow. Everything here must be a cross-owner RESOURCE
 * act, because withElevatedAccess gates on resource:takeover — member
 * administration is member:manage and is audited by its own route under the
 * organization.member.* vocabulary. Recording it through here would have
 * asserted the wrong capability.
 */
export const ELEVATED_ACTIONS = [
  'admin.resource.read',
  'admin.resource.update',
  'admin.resource.reassign',
] as const

export type ElevatedAction = (typeof ELEVATED_ACTIONS)[number]

export type ElevatedContext = {
  action: ElevatedAction
  /** e.g. 'flow' | 'agent' | 'goal' | 'user' */
  resourceType: string
  resourceId: string
  /** The owner being acted upon, when known — the most useful audit detail. */
  targetUserId?: string | null
  /** Any extra structured context worth keeping. Never secrets. */
  detail?: Record<string, unknown>
}

/**
 * Runs `fn` with admin takeover authority, recording an audit event for it.
 *
 * The audit write is deliberately not awaited-and-checked: recordAudit()
 * swallows and reports its own failures because "writing must never break the
 * action it records". A Postgres blip on the audit table must not fail an
 * admin's legitimate operation — the failure is surfaced to Sentry instead.
 */
export async function withElevatedAccess<T>(
  auth: AuthContext,
  context: ElevatedContext,
  fn: () => Promise<T>,
): Promise<T> {
  if (!can(auth.actor, 'resource:takeover')) {
    throw new ApiError('Admin access required', 403, 'FORBIDDEN')
  }

  // Recorded BEFORE the action, so an attempt that then throws is still
  // visible. An admin reaching for someone's data and failing is exactly as
  // interesting as one that succeeded.
  void recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.userId,
    actorKind: 'user',
    action: context.action,
    resourceType: context.resourceType,
    resourceId: context.resourceId,
    detail: { targetUserId: context.targetUserId ?? null, ...context.detail },
  })

  return fn()
}
