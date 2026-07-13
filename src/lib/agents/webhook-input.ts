function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/** Turn an external webhook event into the agent's run input. Structured
 * payloads are preserved as readable JSON instead of being discarded in
 * favor of the agent objective. */
export function agentWebhookInput(body: unknown, objective: string): string {
  if (!isRecord(body)) return objective
  if (Object.prototype.hasOwnProperty.call(body, 'input')) {
    if (typeof body.input === 'string') return body.input.trim() || objective
    if (body.input !== undefined) return JSON.stringify(body.input, null, 2)
  }
  return Object.keys(body).length > 0 ? JSON.stringify(body, null, 2) : objective
}

export function agentWebhookEventName(body: unknown, header: string | null): string | undefined {
  if (header?.trim()) return header.trim().slice(0, 120)
  if (!isRecord(body)) return undefined
  const candidate = body.event ?? body.type
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim().slice(0, 120) : undefined
}
