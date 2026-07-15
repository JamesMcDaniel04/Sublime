/**
 * Row-level access rules for user work (flows, agents, executions).
 *
 * Sharing model — the platform's point is that orchestration is COLLABORATIVE,
 * so a flow/agent can be shared with the whole org, with a role:
 *
 *   private     (default) — owner only (+ a flow's explicitly-invited Jam collaborators)
 *   org_viewer  — anyone in the org may READ and RUN it
 *   org_editor  — anyone in the org may READ, RUN and EDIT it
 *
 * In every case DESTRUCTIVE / privileged actions stay with the owner: delete,
 * publish, trigger secrets, and changing who it's shared with. Sharing must never
 * hand someone else the ability to destroy your work.
 *
 * Three scopes, deliberately separate — "who can see it" must not be the same
 * query as "who can change it":
 *
 *   *ReadScope   — list / open / run
 *   *WriteScope  — edit the thing's content (incl. Flow Jam)
 *   *OwnerScope  — delete / publish / secrets / sharing
 *
 * Callers always combine these with `organizationId`, so an org-shared row can
 * never leak across orgs. Combine via Prisma `AND` when the target `where`
 * already carries an `OR` (two `OR` keys collide in one object).
 */

/** Stored in `Flow.visibility` / `AgentTask.visibility` (both already exist). */
export const VISIBILITY = { private: 'private', orgViewer: 'org_viewer', orgEditor: 'org_editor' } as const
export type Visibility = (typeof VISIBILITY)[keyof typeof VISIBILITY]

/** Shared with the org at any role. */
const ORG_SHARED = [VISIBILITY.orgViewer, VISIBILITY.orgEditor]

export function isVisibility(value: unknown): value is Visibility {
  return value === VISIBILITY.private || value === VISIBILITY.orgViewer || value === VISIBILITY.orgEditor
}

// ── Flows ───────────────────────────────────────────────────────────────────

/** Delete / publish / trigger secrets / changing the share setting. Owner only. */
export function flowOwnerScope(userId: string) {
  return { userId }
}

/** List / open / run: owner, an invited Jam collaborator, or any org share. */
export function flowReadScope(userId: string) {
  return {
    OR: [
      { userId },
      { collaborators: { some: { userId } } },
      { visibility: { in: ORG_SHARED } },
    ],
  }
}

/** Edit the graph (incl. Flow Jam): owner, invited collaborator, or org_editor. */
export function flowWriteScope(userId: string) {
  return {
    OR: [
      { userId },
      { collaborators: { some: { userId } } },
      { visibility: VISIBILITY.orgEditor },
    ],
  }
}

// ── Agents ──────────────────────────────────────────────────────────────────

/** Delete / trigger secrets / changing the share setting. Owner only. */
export function agentOwnerScope(userId: string) {
  return { userId }
}

/** List / open / chat / run: owner or any org share. */
export function agentReadScope(userId: string) {
  return { OR: [{ userId }, { visibility: { in: ORG_SHARED } }] }
}

/** Edit the agent's definition: owner or org_editor. */
export function agentWriteScope(userId: string) {
  return { OR: [{ userId }, { visibility: VISIBILITY.orgEditor }] }
}

// ── Executions ──────────────────────────────────────────────────────────────

/**
 * Execution rows stay visible only to the user who started them, including
 * template runs without a linked saved agent. Sharing a flow does NOT share
 * other people's run history — it can contain their data.
 */
export function executionVisibilityScope(userId: string) {
  return { userId }
}

// NOTE: the old `agentVisibilityScope` / `flowVisibilityScope` helpers are gone.
// They were ambiguous — `agentVisibilityScope` was even used as the owner guard
// on flow publish/delete/trigger-secret — and a single "visibility" rule cannot
// safely answer both "who can see this?" and "who can change it?". Every call
// site now picks an explicit read/write/owner scope above.
