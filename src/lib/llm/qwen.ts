import Anthropic from '@anthropic-ai/sdk'

/**
 * Qwen provider — via DashScope's ANTHROPIC-compatible endpoint.
 *
 * Qwen speaks the Anthropic Messages API on this endpoint, so it reuses the
 * Anthropic SDK (and the whole Anthropic wire path: streaming, tool_use,
 * thinking) rather than a second format. All config is read from the
 * environment — never hardcoded (the key is a secret):
 *
 *   QWEN_API_KEY   — bearer key for the endpoint
 *   QWEN_BASE_URL  — Anthropic-compatible base URL, e.g.
 *                    https://dashscope-intl.aliyuncs.com/apps/anthropic
 *   QWEN_MODEL     — exact model id (e.g. qwen3.7-plus); overrides the UI id
 *
 * ChatGPT/OpenAI is no longer used.
 */

const TIMEOUT_MS = 120_000
const MAX_RETRIES = 1

/** True when the Qwen endpoint is fully configured (key + base URL). */
export function qwenConfigured(): boolean {
  return Boolean(process.env.QWEN_API_KEY && process.env.QWEN_BASE_URL)
}

/** An Anthropic SDK client pointed at the configured Qwen (DashScope) endpoint. */
export function qwenClient(): Anthropic {
  if (!qwenConfigured()) {
    throw new Error('Qwen is not configured — set QWEN_API_KEY and QWEN_BASE_URL')
  }
  return new Anthropic({
    apiKey: process.env.QWEN_API_KEY,
    baseURL: process.env.QWEN_BASE_URL,
    timeout: TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  })
}

/**
 * The exact model string to send. QWEN_MODEL (the id the endpoint expects, e.g.
 * qwen3.7-plus) overrides the UI-facing id when set.
 */
export function qwenModel(requested: string): string {
  return process.env.QWEN_MODEL?.trim() || requested
}
