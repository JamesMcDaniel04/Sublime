/**
 * Format sniffing for /api/flows/import. Order matters: the portable formats
 * declare themselves via `format`; n8n is `nodes` + `connections` (it never
 * has a top-level `graph`); the builder's bare download is `{ graph }`.
 */
import { PORTABLE_AGENT_FORMAT, PORTABLE_FORMAT } from '@/lib/export/portable'

export type DetectedImportFormat = 'sublime-portable' | 'sublime-download' | 'n8n' | 'sublime-agent' | null

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function detectFlowImportFormat(doc: unknown): DetectedImportFormat {
  if (!isRecord(doc)) return null
  if (doc.format === PORTABLE_FORMAT) return 'sublime-portable'
  if (doc.format === PORTABLE_AGENT_FORMAT) return 'sublime-agent'
  if (Array.isArray(doc.nodes) && isRecord(doc.connections)) return 'n8n'
  if (isRecord(doc.graph) && Array.isArray(doc.graph.nodes) && Array.isArray(doc.graph.edges)) return 'sublime-download'
  return null
}
