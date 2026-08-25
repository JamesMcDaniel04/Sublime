/**
 * The stored form of a flow saved as a template.
 *
 * A template is read by other people in the workspace and, once published, by
 * other workspaces. That makes it an export in every sense that matters, so
 * this is a thin seam over the EXISTING export/import pair rather than a new
 * serialization format:
 *
 *   save    → toPortableFlow   (src/lib/export/portable.ts)
 *   provision → fromPortableFlow (src/lib/import/portable.ts)
 *
 * Two properties come from that reuse, and both would be easy to get wrong
 * with a bespoke format:
 *
 *  1. **Credentials never travel.** `toPortableFlow` states the contract at
 *     the top of its own file: sanitization is unconditional, no opt-out. It
 *     drops webhook secret hashes, redacts Authorization/Cookie, redacts
 *     credential-shaped URL/query/body values, and strips vault
 *     `credentialId`s — while preserving portable `nango:`/`native:` ids,
 *     which are exactly what should survive, since they re-resolve to the
 *     IMPORTING workspace's own connection.
 *
 *     A second sanitizer here would drift from that one and leak precisely
 *     what it learned not to.
 *
 *  2. **Agents are inlined, not referenced.** A raw `FlowGraph` carries
 *     `agentId` row ids belonging to the saving workspace. Stored as-is they
 *     mean nothing in another workspace and dangle as soon as the agent is
 *     deleted, so the template would produce a flow whose agent steps point at
 *     nothing. `toPortableFlow` inlines each referenced agent; the import path
 *     re-materializes them and remaps the refs, with DB-backed coverage that
 *     already exists in `flows/__tests__/flow-import.test.ts`.
 */
import { toPortableFlow, type PortableFlow } from '@/lib/export/portable'
import { fromPortableFlow } from '@/lib/import/portable'
import type { FlowGraph } from '@/lib/flows/graph'

/** What a flow-kind template stores under `configuration.portable`. */
export type FlowTemplatePayload = PortableFlow

/**
 * Build the storable payload for a flow being saved as a template.
 *
 * `agents` are the agent rows the graph references, loaded by the caller —
 * they are inlined into the payload so the template is self-contained.
 */
export function flowTemplatePayload(
  flow: { name: string; description?: string; trigger?: unknown; graph: FlowGraph },
  agents: { id: string; title: string; instructions: string; goal?: string | null; model?: string; integrations?: string[] }[],
  exportedAt: string,
): FlowTemplatePayload {
  return toPortableFlow(flow, agents, exportedAt)
}

/**
 * Read a stored payload back into something provisionable.
 *
 * Returns null rather than throwing when the stored value is not a portable
 * document. A template written before this field existed, or by a future
 * version, must degrade to the old instructions-derived behaviour instead of
 * failing the whole provision — a template that errors is worse than a
 * template that is merely less specific.
 */
export function flowTemplateGraph(raw: unknown): { graph: FlowGraph; agentsToCreate: unknown[]; name: string; description: string; trigger: unknown } | null {
  try {
    const imported = fromPortableFlow(raw)
    return {
      graph: imported.graph,
      agentsToCreate: imported.agentsToCreate,
      name: imported.name,
      description: imported.description,
      trigger: imported.trigger,
    }
  } catch {
    return null
  }
}
