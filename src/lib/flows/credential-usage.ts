/**
 * Which credentials/connections a set of flows actually depends on.
 *
 * Pure graph walk backing the Flows page credentials tab: it must agree with
 * what EXECUTION would use, not with what fields happen to be stored on a
 * node. Two consumers of a node's auth fields already exist — the executor
 * (execute-flow.ts) and validation — so the rules here mirror the executor's
 * exactly:
 *
 *   - tool nodes use `data.connectionId` (the tool-connection-id scheme).
 *     `flow:` refs are subflows and `template:` refs are unbound placeholders —
 *     neither is a credential anyone can manage.
 *   - http nodes: `authMode: 'none'` uses nothing; `'generic'` uses the vault
 *     `credentialId`; `'predefined'` uses `connectionId`; a node with no
 *     stored mode (pre-vault graphs) infers from whichever field is populated,
 *     with connectionId winning when both are set.
 *
 * Graphs are treated as untrusted input (publishedGraph rows can predate the
 * current schema) — a malformed graph contributes nothing rather than throwing.
 */
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import { resolveHttpAuthRef } from '@/lib/flows/http-auth-ref'

export type FlowRef = { id: string; name: string }

export type FlowCredentialRefs = {
  /** connection id (tool-connection-id scheme) → flows using it */
  connections: Map<string, FlowRef[]>
  /** vault Credential id → flows using it */
  credentials: Map<string, FlowRef[]>
}

const cleanString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

function addRef(map: Map<string, FlowRef[]>, key: string, flow: FlowRef) {
  const existing = map.get(key)
  if (!existing) {
    map.set(key, [flow])
    return
  }
  if (!existing.some((entry) => entry.id === flow.id)) existing.push(flow)
}

/** Connection ids that are manageable credentials (not subflows/placeholders). */
function manageableConnectionId(id: string): boolean {
  if (!id || id.startsWith('template:')) return false
  return parseFlowToolConnectionId(id).plane !== 'flow'
}

export function collectFlowCredentialRefs(
  flows: Array<{ id: string; name: string; graphs: unknown[] }>,
): FlowCredentialRefs {
  const connections = new Map<string, FlowRef[]>()
  const credentials = new Map<string, FlowRef[]>()

  for (const flow of flows) {
    const ref: FlowRef = { id: flow.id, name: flow.name }
    for (const graph of flow.graphs) {
      const nodes = graph && typeof graph === 'object' ? (graph as { nodes?: unknown }).nodes : null
      if (!Array.isArray(nodes)) continue
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue
        const { type, data } = node as { type?: unknown; data?: unknown }
        if (!data || typeof data !== 'object') continue
        const fields = data as Record<string, unknown>

        if (type === 'tool') {
          const connectionId = cleanString(fields.connectionId)
          if (manageableConnectionId(connectionId)) addRef(connections, connectionId, ref)
          continue
        }

        if (type === 'http') {
          // Shared with execute-flow.ts and the runtime audit trail, so this
          // inventory cannot drift from what execution actually uses.
          const authRef = resolveHttpAuthRef(fields)
          if (authRef.kind === 'credential') addRef(credentials, authRef.credentialId, ref)
          else if (authRef.kind === 'connection' && manageableConnectionId(authRef.connectionId)) {
            addRef(connections, authRef.connectionId, ref)
          }
        }
      }
    }
  }

  return { connections, credentials }
}
