/**
 * Programmatic flow activation — a thin wrapper over the single publish
 * writer (src/lib/flows/publish.ts). Kept because template provisioning and
 * suggestion-acceptance callers depend on this exact contract: return the
 * reason rather than throw, so a bad graph degrades to DRAFT.
 */
import { publishFlowDraft } from '@/lib/flows/publish'

export type ActivateFlowResult = { activated: true } | { activated: false; reason: string }

export async function activateFlow(
  flowId: string,
  organizationId: string,
  userId: string,
): Promise<ActivateFlowResult> {
  const result = await publishFlowDraft(flowId, organizationId, userId)
  return result.published ? { activated: true } : { activated: false, reason: result.reason }
}
