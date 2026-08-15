/**
 * Process-wide logger. Every message and meta object passes through
 * redactSecrets before reaching stdout: Sentry and the LLM transcript were
 * already scrubbed at their own boundaries, but stdout ships verbatim to the
 * platform log drain — and error messages from third-party HTTP clients are
 * exactly where a tokenised URL or auth header ends up.
 */
import { redactSecrets } from '@/lib/llm/guardrails'

function scrubMeta(meta: Record<string, unknown>): unknown {
  try {
    return JSON.parse(redactSecrets(JSON.stringify(meta)))
  } catch {
    // Unserialisable meta (circular refs, BigInt): scrub what can be read
    // shallowly rather than dropping the log line.
    const shallow: Record<string, string> = {}
    for (const [key, value] of Object.entries(meta)) {
      try {
        shallow[key] = redactSecrets(typeof value === 'string' ? value : String(value))
      } catch {
        shallow[key] = '[unserialisable]'
      }
    }
    return shallow
  }
}

function emit(sink: (...args: unknown[]) => void, message: string, meta?: Record<string, unknown>) {
  sink(`[api] ${redactSecrets(message)}`, meta ? scrubMeta(meta) : '')
}

export const apiLogger = {
  error(message: string, meta?: Record<string, unknown>) {
    emit(console.error, message, meta)
  },
  warn(message: string, meta?: Record<string, unknown>) {
    emit(console.warn, message, meta)
  },
  info(message: string, meta?: Record<string, unknown>) {
    emit(console.log, message, meta)
  },
}
