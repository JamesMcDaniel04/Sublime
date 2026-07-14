/**
 * Client-safe shape of the flow tool catalog the builder UI passes around
 * (cards, picker, canvas). Structurally matches the server loader's
 * FlowToolCatalogConnection (src/lib/flows/tool-catalog.ts) — kept separate
 * because that module imports server-only code (prisma via tool-planes).
 */
export type ToolCatalog = {
  id: string
  name: string
  tools: { name: string; description: string; inputSchema?: unknown; outputSchema?: unknown; schemaHash?: string; risk?: 'read' | 'write' | 'destructive' }[]
  toolsError?: string
  /**
   * Whether this connector is already connected/active for the user. Absent is
   * treated as connected (backward compatible). When `false`, the connector is
   * browsable-but-not-connected: its tools are advertised for discovery, and
   * picking one connects first (see `connect`) before inserting the node.
   */
  connected?: boolean
  /** Present on not-yet-connected connectors: how to connect before inserting. */
  connect?: { plane: 'klavis'; provider: string }
}[]
