/**
 * A store listing is a snapshot of an agent another workspace can install as
 * a teammate. Two kinds: a NATIVE package (objective, integrations, grants —
 * Sublime runs it) and an EXTERNAL package (the publisher's endpoint — the
 * publisher runs it, the installer brings a credential). This is monday's
 * store in Sublime's terms: a plugin becomes a teammate.
 *
 * The one invariant that matters: a definition never carries a secret.
 * Skills and HTTP endpoints are dropped too — both reference vault rows that
 * exist only in the publisher's workspace.
 *
 * Pure, so it is unit-testable and shared by the routes and the UI.
 */
import { parseGrants, type AgentGrants } from '@/lib/agents/grants'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { EXTERNAL_AUTH_TYPES, type ExternalAuthType } from '@/lib/agents/external-agent'

export type ListingKind = 'native' | 'external'
export type ListingVisibility = 'organization' | 'public'

export type NativeDefinition = {
  title: string
  description: string
  instructions: string
  goal: string | null
  model: string | null
  integrations: string[]
  grants: AgentGrants | null
  outputFields: unknown[]
}
export type ExternalDefinition = {
  title: string
  description: string
  objective: string
  endpointUrl: string
  authType: ExternalAuthType
  headerName: string | null
  timeoutMinutes: number
}
export type ListingDefinition =
  | { kind: 'native'; native: NativeDefinition }
  | { kind: 'external'; external: ExternalDefinition }

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'agent'
}

type SnapshotAgent = {
  description: string | null
  objective: string
  goal: string | null
  metadata: unknown
  grants: unknown
  runtime?: string | null
}
type SnapshotBinding = { endpointUrl: string; authType: string; authConfig: unknown; timeoutMinutes: number } | null

/** The definition a listing stores for this agent. Throws only on an external agent with no binding. */
export function snapshotDefinition(agent: SnapshotAgent, binding: SnapshotBinding): ListingDefinition {
  const metadata = readAgentMetadata(agent.metadata)
  const title = metadata.title?.trim() || agent.description?.split('\n')[0]?.trim() || 'Untitled agent'
  const description = (metadata.description ?? '').trim()
  if (agent.runtime === 'external') {
    if (!binding) throw new Error('This external agent has no endpoint to publish')
    const config = binding.authConfig && typeof binding.authConfig === 'object' ? (binding.authConfig as Record<string, unknown>) : {}
    return {
      kind: 'external',
      external: {
        title,
        description,
        objective: agent.objective,
        endpointUrl: binding.endpointUrl,
        authType: (EXTERNAL_AUTH_TYPES as readonly string[]).includes(binding.authType) ? (binding.authType as ExternalAuthType) : 'none',
        // The header NAME travels; the secret never does.
        headerName: typeof config.headerName === 'string' ? config.headerName : null,
        timeoutMinutes: binding.timeoutMinutes,
      },
    }
  }
  return {
    kind: 'native',
    native: {
      title,
      description,
      instructions: agent.objective,
      goal: agent.goal ?? null,
      model: metadata.model ?? null,
      integrations: Array.isArray(metadata.integrations) ? metadata.integrations.map(String) : [],
      grants: parseGrants(agent.grants),
      outputFields: Array.isArray(metadata.outputFields) ? metadata.outputFields : [],
    },
  }
}

/** Validate a stored definition. Null when it is not one we can install. */
export function parseDefinition(value: unknown): ListingDefinition | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.kind === 'native' && v.native && typeof v.native === 'object') {
    const n = v.native as Record<string, unknown>
    if (typeof n.title !== 'string' || typeof n.instructions !== 'string') return null
    return {
      kind: 'native',
      native: {
        title: n.title,
        description: typeof n.description === 'string' ? n.description : '',
        instructions: n.instructions,
        goal: typeof n.goal === 'string' ? n.goal : null,
        model: typeof n.model === 'string' ? n.model : null,
        integrations: Array.isArray(n.integrations) ? n.integrations.map(String) : [],
        grants: parseGrants(n.grants),
        outputFields: Array.isArray(n.outputFields) ? n.outputFields : [],
      },
    }
  }
  if (v.kind === 'external' && v.external && typeof v.external === 'object') {
    const e = v.external as Record<string, unknown>
    if (typeof e.title !== 'string' || typeof e.endpointUrl !== 'string' || typeof e.objective !== 'string') return null
    return {
      kind: 'external',
      external: {
        title: e.title,
        description: typeof e.description === 'string' ? e.description : '',
        objective: e.objective,
        endpointUrl: e.endpointUrl,
        authType: (EXTERNAL_AUTH_TYPES as readonly string[]).includes(String(e.authType)) ? (e.authType as ExternalAuthType) : 'none',
        headerName: typeof e.headerName === 'string' ? e.headerName : null,
        timeoutMinutes: typeof e.timeoutMinutes === 'number' && e.timeoutMinutes > 0 ? e.timeoutMinutes : 10,
      },
    }
  }
  return null
}

/** An external listing whose endpoint authenticates needs the installer's own credential. */
export function installRequiresSecret(definition: ListingDefinition): boolean {
  return definition.kind === 'external' && definition.external.authType !== 'none'
}

export function updateAvailable(installedVersion: number, listingVersion: number): boolean {
  return listingVersion > installedVersion
}

/** True when any key anywhere in a value looks like it holds a secret. */
export function containsSecretKey(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsSecretKey)
  return Object.entries(value as Record<string, unknown>).some(([key, inner]) => /secret|token|password|Enc$/i.test(key) || containsSecretKey(inner))
}
