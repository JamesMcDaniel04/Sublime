/**
 * Best-effort destination host for an agent tool call, for the audit trail.
 *
 * The flow-HTTP plane records the host in its audit `tool` field; the agent
 * plane recorded only the tool name and provider, with the actual URL buried in
 * the payload — which recordAudit HASHES. So after a key rotation, "what host
 * did this agent's credential reach?" was unanswerable. This recovers the host
 * for the two agent egress shapes:
 *   - the `request` builtin and agent HTTP tools carry the target in input.url
 *   - an MCP tool call's destination is its server url
 * Returns undefined when neither yields a parseable URL (e.g. a native
 * connector whose destination is implicit in the provider).
 */
export function auditEgressHost(input: unknown, serverUrl?: string | null): string | undefined {
  const fromInput =
    input && typeof input === 'object' && !Array.isArray(input) && typeof (input as { url?: unknown }).url === 'string'
      ? (input as { url: string }).url
      : ''
  const candidate = fromInput || serverUrl || ''
  if (!candidate) return undefined
  try {
    return new URL(candidate).hostname
  } catch {
    return undefined
  }
}
