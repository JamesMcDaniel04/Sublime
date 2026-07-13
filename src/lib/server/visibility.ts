/**
 * Organization membership shares the integration and template catalogues, not
 * user work. Agents, flows, and execution history are always owner-private.
 *
 * Combine with other conditions via Prisma `AND` when the target `where`
 * already carries an `OR` (two `OR` keys collide in one object).
 */

/** Agent rows are visible only to their creator. */
export function agentVisibilityScope(userId: string) {
  return { userId }
}

/**
 * Flows remain personal unless their owner explicitly grants Jam access.
 * Merely belonging to the same organization never exposes a flow.
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
 * Execution rows are visible only to the user who started them, including
 * template runs without a linked saved agent.
 */
export function executionVisibilityScope(userId: string) {
  return { userId }
}
