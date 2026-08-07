import { FIELD_TYPES, type FlowGraph, type TriggerInputField } from '@/lib/flows/graph'

export const FLOW_TRIGGER_TYPES = ['manual', 'schedule', 'webhook', 'signal', 'slack', 'activity', 'poll'] as const
export type FlowTriggerType = (typeof FLOW_TRIGGER_TYPES)[number]
export type FlowTrigger = { type: FlowTriggerType; [key: string]: unknown }

// Signals a flow's trigger can listen for (a signal-type trigger fires when a
// flow or agent completes elsewhere in the org). Client-safe — no prisma — so
// the builder UI can import this list directly.
export const KNOWN_SIGNALS = ['flow.completed', 'agent.completed'] as const
export type KnownSignal = (typeof KNOWN_SIGNALS)[number]

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function validTriggerType(value: unknown): value is FlowTriggerType {
  return typeof value === 'string' && (FLOW_TRIGGER_TYPES as readonly string[]).includes(value)
}

export function normalizeFlowTrigger(value: unknown, fallback?: unknown): FlowTrigger {
  const input = isRecord(value) ? value : undefined
  const base = input ?? (isRecord(fallback) ? fallback : {})
  const type = validTriggerType(base.type) ? base.type : 'manual'
  return { ...base, type }
}

/**
 * The builder stores the editable trigger on the graph's trigger node. Runtime
 * dispatchers read Flow.trigger, so every save/publish must sync this value.
 */
export function triggerFromGraph(graph: FlowGraph, fallback?: unknown): FlowTrigger {
  const node = graph.nodes.find((candidate) => candidate.type === 'trigger')
  const trigger = node?.type === 'trigger' ? node.data.trigger : undefined
  return normalizeFlowTrigger(trigger, fallback)
}

export function preserveWebhookSecretHash(next: unknown, existing: unknown): FlowTrigger {
  const trigger = normalizeFlowTrigger(next)
  if (isRecord(existing)) {
    // The client never sees either field, so a plain PUT would wipe them.
    if (typeof existing.webhookSecretHash === 'string') trigger.webhookSecretHash = existing.webhookSecretHash
    if (typeof existing.webhookSecretEnc === 'string') trigger.webhookSecretEnc = existing.webhookSecretEnc
  }
  return trigger
}

/** Normalize the trigger's declared input fields from untrusted JSON. */
export function triggerInputFieldsFromTrigger(trigger: unknown): TriggerInputField[] {
  if (!isRecord(trigger) || !Array.isArray(trigger.inputFields)) return []
  return trigger.inputFields.filter(isRecord).map((field) => ({
    name: typeof field.name === 'string' ? field.name : '',
    type: (FIELD_TYPES as readonly string[]).includes(String(field.type)) ? (field.type as TriggerInputField['type']) : 'any',
    description: typeof field.description === 'string' ? field.description : undefined,
    required: field.required === true,
  }))
}
