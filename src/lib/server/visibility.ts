/**
 * Tenant + owner visibility scopes, shared by every authenticated route.
 *
 * An organization is a billing/catalog boundary, not a content-sharing
 * boundary. Agents, flows, runs, messages, search hits, and trigger secrets
 * are always personal to their creator. Integrations expose an org-curated
 * catalogue separately, while each user's credentials remain user-scoped.
 *
 * Combine with other conditions via Prisma `AND` when the target `where`
 * already carries an `OR` (two `OR` keys collide in one object).
 */

/** Agent/flow rows: only rows owned by the acting user are visible. */
export function agentVisibilityScope(userId: string) {
  return { userId }
}

/**
 * Flow rows remain private by default, but an explicit Flow Jam invitation
 * grants edit access to that one flow. This is deliberately narrower than the
 * legacy `visibility: shared` organization-wide scope.
 */
export function flowVisibilityScope(userId: string) {
  return {
    OR: [
      { userId },
      { collaborators: { some: { userId } } },
    ],
  }
}

/**
 * Execution rows are personal even when they were started from a template or
 * have no linked agent. Every normal run creation path records the acting (or
 * scheduled owner) user on AgentExecution.userId.
 */
export function executionVisibilityScope(userId: string) {
  return { userId }
}
