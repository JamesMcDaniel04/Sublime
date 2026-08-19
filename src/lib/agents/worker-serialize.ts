import { normalizeRoleLabel } from '@/lib/agents/role-label'

/**
 * The wire shape for a worker — the person-shaped tile on the roster that a
 * group of agents works under.
 *
 * `agentIds` carries only the members the VIEWER can read, so a worker never
 * reveals the existence of a private agent belonging to someone else.
 */
export function serializeWorker(worker: {
  id: string
  name: string
  avatarSeed: string | null
  roleLabel: string | null
  userId: string | null
  createdAt: Date
}, visibleAgentIds: string[]) {
  return {
    id: worker.id,
    name: worker.name,
    avatarSeed: worker.avatarSeed,
    // Normalized on the way out for the same reason agent labels are: stored
    // text is not trusted text.
    roleLabel: normalizeRoleLabel(worker.roleLabel),
    agentIds: visibleAgentIds,
    createdAt: worker.createdAt,
  }
}

export type SerializedWorker = ReturnType<typeof serializeWorker>
