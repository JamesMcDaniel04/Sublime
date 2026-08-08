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

/**
 * Steps that shared one credential in the source system. Credentials never
 * travel, but the GROUPING does — so one vault credential can be bound to
 * every member step in a single action instead of per-step hunting.
 */
export type CredentialGroup = {
  /** Source-system credential identity (type + id/name). */
  key: string
  /** Source credential type (e.g. salesforceOAuth2Api). */
  sourceType: string
  /** Display name from the source system. */
  name: string
  /** Vault credential type the picker should pre-select. Absent when unsupported. */
  credentialType?: 'basic' | 'bearer' | 'oauth1' | 'oauth2' | 'apiKeyHeader' | 'apiKeyQuery' | 'custom'
  /** Prefill for the credential-create form — names only, secrets never travel. */
  suggestedHeaderName?: string
  suggestedQueryParam?: string
  suggestedEntries?: { kind: 'header' | 'query'; name: string }[]
  /** n8n's human label for the credential type (e.g. "Shopify Access Token API"). */
  sourceDisplayName?: string
  /** Set when generic injection cannot reproduce this credential's auth. */
  unsupported?: { reason: string }
  nodeIds: string[]
}

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
  /** Source-credential groupings for one-click vault binding after import. */
  credentialGroups?: CredentialGroup[]
  /** n8n pinData (per-node sample outputs) — lands as FlowNodePins, so token
   *  previews work the moment the flow opens. */
  pins?: Record<string, unknown>
  /**
   * Sibling flows created alongside this one — an n8n workflow with N
   * triggers splits into N Sublime flows (one trigger each), the shared
   * tail duplicated into each.
   */
  additionalFlows?: ImportedFlow[]
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
