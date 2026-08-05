/**
 * Flow import — shared types for the converters (detect → convert → sanitize)
 * and the /api/flows/import route that orchestrates them.
 */
import type { FlowGraph } from '@/lib/flows/graph'
import type { FlowTrigger } from '@/lib/flows/trigger'
import type { PortableAgent } from '@/lib/export/portable'

export type FlowImportSource = 'sublime-portable' | 'sublime-download' | 'n8n'

/** An n8n integration node imported as an HTTP stub — reported, never silent. */
export type StubbedNode = { nodeId: string; label: string; originalType: string }

export type ImportedFlow = {
  name: string
  description: string
  trigger: FlowTrigger
  graph: FlowGraph
  /** Agents inlined in a portable doc — materialized on import, then agent refs remapped. */
  agentsToCreate: PortableAgent[]
  source: FlowImportSource
  warnings: string[]
  stubbedNodes: StubbedNode[]
}

/** Converter-level failure with a stable code the route maps onto ApiError. */
export class FlowImportError extends Error {
  constructor(
    message: string,
    readonly code: 'UNRECOGNIZED_FORMAT' | 'AGENT_EXPORT' | 'INVALID_GRAPH',
  ) {
    super(message)
    this.name = 'FlowImportError'
  }
}
