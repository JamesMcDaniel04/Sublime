/**
 * Embeddings client for graph-RAG.
 *
 * Default provider: Voyage AI (VOYAGE_API_KEY) — Anthropic's recommended
 * embeddings, billed independently of the model keys. The provider is behind a
 * small seam so it can be swapped (OpenAI, a local model) without touching the
 * retrieval/indexing code.
 *
 * Gated: when no key is configured, `embeddingsConfigured()` is false and
 * callers skip RAG augmentation gracefully rather than erroring.
 */

import { createHash } from 'node:crypto'
import { cacheGet, cacheSet } from '@/lib/cache'

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings'
// voyage-3 family: 1024-dim general-purpose embeddings; `voyage-3` is the
// balanced default. Override with VOYAGE_EMBED_MODEL if needed.
const DEFAULT_MODEL = 'voyage-3'
export const EMBEDDING_DIM = 1024
// Embeddings are deterministic for a given (model, input_type, text), so cache
// aggressively — the TTL only bounds cache size. Cuts cost + rate-limit
// pressure on re-indexing identical content and on repeated queries.
const EMBED_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export function embeddingsConfigured(): boolean {
  return Boolean(process.env.VOYAGE_API_KEY)
}

export interface EmbedOptions {
  /** 'document' when indexing stored content, 'query' when embedding a search. */
  inputType?: 'document' | 'query'
  fetchImpl?: typeof fetch
  model?: string
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Embed a batch of texts. Returns one vector per input, in order.
 *
 * Cached per-text by (model, input_type, content hash): cache hits are served
 * without a network call and only the misses are sent to Voyage in one batched
 * request — so re-indexing identical content or repeating a query is free.
 * Caching is skipped when a fetch is injected (tests). Empty/failed vectors are
 * never cached.
 */
export async function embedTexts(texts: string[], options: EmbedOptions = {}): Promise<number[][]> {
  if (texts.length === 0) return []
  const apiKey = process.env.VOYAGE_API_KEY
  if (!apiKey) throw new Error('VOYAGE_API_KEY is not configured')

  const model = options.model || process.env.VOYAGE_EMBED_MODEL || DEFAULT_MODEL
  const inputType = options.inputType ?? 'document'

  // Tests inject a fetch and don't want cache interference or real backoff.
  if (options.fetchImpl) {
    return fetchEmbeddings(texts, { apiKey, model, inputType, fetchImpl: options.fetchImpl, maxAttempts: 1 })
  }

  const keyOf = (text: string) => `emb:${model}:${inputType}:${sha256(text)}`
  const out = new Array<number[]>(texts.length)
  const missTexts: string[] = []
  const missIndexes: number[] = []

  for (let i = 0; i < texts.length; i++) {
    const hit = await cacheGet<number[]>(keyOf(texts[i]))
    if (hit && hit.length > 0) out[i] = hit
    else { missTexts.push(texts[i]); missIndexes.push(i) }
  }

  if (missTexts.length > 0) {
    const fetched = await fetchEmbeddings(missTexts, { apiKey, model, inputType, fetchImpl: fetch, maxAttempts: 6 })
    for (let j = 0; j < missTexts.length; j++) {
      const vector = fetched[j] ?? []
      out[missIndexes[j]] = vector
      if (vector.length > 0) await cacheSet(keyOf(missTexts[j]), vector, EMBED_CACHE_TTL_MS)
    }
  }

  for (let i = 0; i < out.length; i++) if (!out[i]) out[i] = []
  return out
}

interface FetchEmbedOptions {
  apiKey: string
  model: string
  inputType: 'document' | 'query'
  fetchImpl: typeof fetch
  maxAttempts: number
}

/**
 * Raw Voyage call. Retries on rate limits (429) and provider outages (5xx) with
 * backoff honoring Retry-After — Voyage's free tier is a few requests/minute,
 * so indexing bursts would otherwise 429. Non-retryable errors (bad key, bad
 * request) throw immediately, status-tagged.
 */
async function fetchEmbeddings(texts: string[], opts: FetchEmbedOptions): Promise<number[][]> {
  let response: Response | undefined
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    response = await opts.fetchImpl(VOYAGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({ model: opts.model, input: texts, input_type: opts.inputType }),
      signal: AbortSignal.timeout(30_000),
    })
    if (response.ok) break
    const retryable = response.status === 429 || response.status >= 500
    if (!retryable || attempt === opts.maxAttempts) break
    const retryAfter = Number(response.headers.get('retry-after'))
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(1000 * 2 ** (attempt - 1), 20_000) // 1s,2s,4s,8s,16s,20s
    await sleep(waitMs)
  }

  if (!response || !response.ok) {
    const error = new Error(`Voyage embeddings request failed (${response?.status ?? 'no response'})`) as Error & { status?: number }
    error.status = response?.status
    throw error
  }

  const data = (await response.json()) as { data?: Array<{ embedding: number[]; index: number }> }
  const rows = data.data ?? []
  // Voyage returns items with an explicit index; order defensively.
  const ordered = new Array<number[]>(texts.length)
  for (const row of rows) ordered[row.index] = row.embedding
  for (let i = 0; i < ordered.length; i++) if (!ordered[i]) ordered[i] = []
  return ordered
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export async function embedQuery(text: string, options: EmbedOptions = {}): Promise<number[]> {
  const [vector] = await embedTexts([text], { ...options, inputType: 'query' })
  return vector ?? []
}

/** Cosine similarity between two equal-length vectors (0 when either is empty). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
