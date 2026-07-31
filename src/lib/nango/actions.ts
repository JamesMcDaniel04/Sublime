/**
 * Nango deployed actions — the dynamic tool surface for connected accounts.
 *
 * The Nango dashboard lets each integration deploy catalog "functions"
 * (actions) with typed JSON-schema inputs. When an integration has deployed
 * actions, they REPLACE the hand-rolled DELIVERY_TOOLS specs for that
 * capability at plane-load time (see loadNangoPlaneGroups): richer coverage,
 * provider-maintained request shapes, and one execution path (triggerAction)
 * instead of raw proxy calls. Integrations with no deployed actions fall back
 * to the static specs.
 *
 * The catalog is a property of the Nango ENVIRONMENT (same for every org) and
 * changes only when someone deploys functions in the dashboard — cached a few
 * minutes to keep plane loads off the Nango API.
 */
import { getNangoClient, nangoDeadline } from './client'
import { cached } from '@/lib/cache'
import type { DeliveryConnection } from './delivery'

export type NangoActionTool = {
  /** The Nango action name to trigger (e.g. 'create-record'). */
  actionName: string
  /** The agent-facing tool name (e.g. 'salesforce_create_record'). */
  toolName: string
  description: string
  inputSchema: Record<string, unknown>
}

type ScriptsConfigEntry = {
  providerConfigKey: string
  actions?: Array<{
    name: string
    description?: string
    enabled?: boolean
    input?: string | null
    json_schema?: { definitions?: Record<string, unknown> } | null
  }>
}

const CACHE_KEY = 'nango:actions-catalog'
const CACHE_TTL_MS = 10 * 60 * 1000

/** providerConfigKey → enabled deployed actions (raw catalog entries). */
export type ActionsCatalog = Record<string, Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>>

/** Agent tool names must be [a-zA-Z0-9_-]; action names are kebab-case. */
export function actionToolName(capability: string, actionName: string): string {
  return `${capability}_${actionName}`.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()
}

/**
 * An action's input model is a named definition inside its json_schema; other
 * definitions may be $ref'd from it, so they ride along under `definitions`
 * (the same URI space `#/definitions/...` the refs use).
 */
export function actionInputSchema(action: {
  input?: string | null
  json_schema?: { definitions?: Record<string, unknown> } | null
}): Record<string, unknown> {
  const definitions = action.json_schema?.definitions ?? {}
  const input = action.input ? (definitions[action.input] as Record<string, unknown> | undefined) : undefined
  if (!input) return { type: 'object', properties: {} }
  const referenced = Object.fromEntries(Object.entries(definitions).filter(([name]) => name !== action.input))
  return Object.keys(referenced).length ? { ...input, definitions: referenced } : { ...input }
}

async function fetchActionsCatalog(): Promise<ActionsCatalog> {
  const entries = (await nangoDeadline(getNangoClient().getScriptsConfig(), undefined, 'nango getScriptsConfig')) as unknown as ScriptsConfigEntry[]
  const catalog: ActionsCatalog = {}
  for (const entry of entries) {
    const actions = (entry.actions ?? []).filter((action) => action.enabled !== false)
    if (!actions.length) continue
    catalog[entry.providerConfigKey] = actions.map((action) => ({
      name: action.name,
      description: action.description || `Run the ${action.name} action.`,
      inputSchema: actionInputSchema(action),
    }))
  }
  return catalog
}

/**
 * Enabled deployed actions for one providerConfigKey, as agent tool specs.
 * Fail-open to [] — a catalog outage must degrade to the static delivery
 * tools, never break plane loading.
 */
export async function listActionTools(providerConfigKey: string, capability: string): Promise<NangoActionTool[]> {
  let catalog: ActionsCatalog
  try {
    catalog = await cached(CACHE_KEY, CACHE_TTL_MS, fetchActionsCatalog)
  } catch {
    return []
  }
  return (catalog[providerConfigKey] ?? []).map((action) => ({
    actionName: action.name,
    toolName: actionToolName(capability, action.name),
    description: action.description,
    inputSchema: action.inputSchema,
  }))
}

/** Ceiling for one action trigger; actions can be slower than raw proxy calls. */
function actionTimeoutMs(): number {
  const parsed = Math.floor(Number(process.env.NANGO_ACTION_TIMEOUT_MS))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000
}

/** Trigger a deployed action on the connection, bounded by a deadline. */
export async function runNangoAction(
  connection: DeliveryConnection,
  actionName: string,
  input: unknown,
  trigger: (providerConfigKey: string, connectionId: string, actionName: string, input?: unknown) => Promise<unknown> = (
    providerConfigKey,
    connectionId,
    name,
    args,
  ) => getNangoClient().triggerAction(providerConfigKey, connectionId, name, args),
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const ms = actionTimeoutMs()
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Nango action ${actionName} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([trigger(connection.providerConfigKey, connection.connectionId, actionName, input), deadline])
  } finally {
    clearTimeout(timer)
  }
}
