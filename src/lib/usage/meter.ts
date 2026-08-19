/**
 * The single chokepoint for recording AI spend against a workspace.
 *
 * Credits are the product's unit of price (1 credit = 1,000 tokens), and the
 * same counter enforces the monthly ceiling — so a dropped write both
 * under-bills the workspace and quietly raises its cap. Every call site used to
 * be `void recordTokenUsage(...).catch(() => undefined)`: a failure was
 * indistinguishable from success and nothing counted the misses.
 *
 * This never throws — metering must not break the request it is measuring —
 * but it never fails silently either.
 */
import { recordTokenUsage } from '@/lib/usage/budget'
import { apiLogger } from '@/lib/logger'

type Deps = {
  record?: (organizationId: string, tokens: number) => Promise<number | null>
  logger?: { error: (message: string, meta?: unknown) => void }
}

export async function meterTokens(
  input: {
    organizationId: string
    tokens: number
    /** Route or subsystem the spend came from, for the failure log. */
    path: string
    /**
     * True when `tokens` is a character-count approximation rather than the
     * provider's own usage. Marked so estimated billing stays auditable.
     */
    estimated?: boolean
  },
  deps: Deps = {},
): Promise<void> {
  const { organizationId, tokens, path, estimated = false } = input
  if (!Number.isFinite(tokens) || tokens <= 0) return

  const record = deps.record ?? recordTokenUsage
  const logger = deps.logger ?? apiLogger
  try {
    const total = await record(organizationId, tokens)
    // recordTokenUsage returns null when the counter backend is unavailable.
    if (total === null) {
      logger.error('usage: token spend was not counted (meter backend unavailable)', {
        organizationId, tokens, path, estimated,
      })
    }
  } catch (error) {
    logger.error('usage: token spend failed to record', {
      organizationId, tokens, path, estimated,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
