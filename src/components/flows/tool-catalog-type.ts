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
}[]
