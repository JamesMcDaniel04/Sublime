/**
 * Unified agent tool registry.
 *
 * An agent draws tools from several planes — People.ai (read), Klavis (read/
 * MCP), custom MCP connections, native (Granola), and Nango (delivery/write).
 * This merges them into one deduped list the model sees, tagging each with its
 * provenance so the runtime knows how to execute it and the UI can show origin.
 *
 * Pure and side-effect-free: callers pass already-discovered descriptors; this
 * only orders, dedupes, and tags. First writer wins on a name collision.
 */

export type ToolProvenance = 'people_ai' | 'klavis' | 'mcp' | 'native' | 'nango'

export interface RegistryToolInput {
  name: string
  description?: string
  inputSchema?: unknown
  provenance: ToolProvenance
}

export interface RegistryTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  provenance: ToolProvenance
}

const EMPTY_SCHEMA: Record<string, unknown> = { type: 'object', properties: {} }

function normalizeSchema(schema: unknown): Record<string, unknown> {
  return schema && typeof schema === 'object' && !Array.isArray(schema)
    ? (schema as Record<string, unknown>)
    : EMPTY_SCHEMA
}

/**
 * Merge tool descriptors from all planes. Order of `groups` is the precedence
 * order for name collisions (earlier groups win). Returns a deduped, tagged
 * list plus the dropped duplicates (for logging/telemetry).
 */
export function buildToolRegistry(groups: RegistryToolInput[][]): {
  tools: RegistryTool[]
  dropped: Array<{ name: string; provenance: ToolProvenance; keptProvenance: ToolProvenance }>
} {
  const byName = new Map<string, RegistryTool>()
  const dropped: Array<{ name: string; provenance: ToolProvenance; keptProvenance: ToolProvenance }> = []

  for (const group of groups) {
    for (const input of group) {
      const existing = byName.get(input.name)
      if (existing) {
        dropped.push({ name: input.name, provenance: input.provenance, keptProvenance: existing.provenance })
        continue
      }
      byName.set(input.name, {
        name: input.name,
        description: input.description || input.name,
        inputSchema: normalizeSchema(input.inputSchema),
        provenance: input.provenance,
      })
    }
  }

  return { tools: [...byName.values()], dropped }
}
