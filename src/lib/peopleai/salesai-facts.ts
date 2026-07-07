/**
 * Sales AI facts — typed reads against the People.ai MCP tools (verified live
 * via tools/list on mcp.people.ai). Used to enrich graph-RAG entity nodes with
 * real account/opportunity intelligence (risks, next steps, status) instead of
 * bare ids, so retrieval surfaces substance the model can reason over.
 *
 * All reads are best-effort: any failure returns null and the caller keeps the
 * basic node. IDs are the integer `peopleai_*_id`s; a CRM/Salesforce id is
 * resolved via find_record_by_crm_id first.
 */

import { cacheGet, cacheSet } from '@/lib/cache'

/** Minimal shape of the People.ai client — just what facts need (injectable for tests). */
export interface SalesAiCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>
}

export interface EnrichedEntity {
  text: string
  peopleaiId: number
}

export interface EnrichOptions {
  /**
   * When set, cache the successful result under this scope. Use the identity the
   * `client` reads as — e.g. `org:<orgId>` for the service (org-shared) client —
   * so one rep's private view can't be served to another. Omit to skip caching.
   */
  cacheScope?: string
  cacheTtlMs?: number
  /**
   * Invoked when the result was served from cache (no live MCP call). Lets a
   * caller (e.g. the backfill circuit breaker) treat cache hits as neutral —
   * a fast cache hit says nothing about live-endpoint health.
   */
  onCacheHit?: () => void
}

// Sales AI status changes slowly; 15 min balances freshness against MCP cost.
const SALES_AI_TTL_MS = 15 * 60 * 1000

/** Extract concatenated text from an MCP tool result's content blocks. */
export function extractMcpText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n')
      .trim()
  }
  if (typeof result === 'string') return result.trim()
  return ''
}

function numericId(ref: string | number | null | undefined): number | null {
  if (ref == null) return null
  const str = String(ref).trim()
  return /^\d+$/.test(str) ? Number(str) : null
}

/**
 * Resolve a reference to a People.ai integer account id. Passes through numeric
 * ids; for a CRM/Salesforce id, resolves via find_record_by_crm_id and reads
 * the first `peopleai_account_id` it can find in the result JSON.
 */
async function resolveAccountId(client: SalesAiCaller, ref: string | number): Promise<number | null> {
  const direct = numericId(ref)
  if (direct != null) return direct
  try {
    const result = await client.callTool('find_record_by_crm_id', { crm_id: String(ref) })
    const text = extractMcpText(result)
    const match = /peopleai[_-]?account[_-]?id["\s:]+(\d+)/i.exec(text)
    return match ? Number(match[1]) : null
  } catch {
    return null
  }
}

export async function enrichAccount(
  client: SalesAiCaller,
  accountRef: string | number,
  opts: EnrichOptions = {},
): Promise<EnrichedEntity | null> {
  const id = await resolveAccountId(client, accountRef)
  if (id == null) return null
  const fetchFacts = async (): Promise<EnrichedEntity | null> => {
    try {
      const result = await client.callTool('get_account_status', { peopleai_account_id: id })
      const text = extractMcpText(result)
      return text ? { text: text.slice(0, 2000), peopleaiId: id } : null
    } catch {
      return null
    }
  }
  // Manual get/fetch/set (not cached()) so we can signal a cache hit to the
  // caller. Negatives aren't cached, so a timeout won't suppress future
  // enrichment; only real facts are stored.
  if (!opts.cacheScope) return fetchFacts()
  const key = `sai:acct:${opts.cacheScope}:${id}`
  const hit = await cacheGet<EnrichedEntity>(key)
  if (hit) { opts.onCacheHit?.(); return hit }
  const facts = await fetchFacts()
  if (facts) await cacheSet(key, facts, opts.cacheTtlMs ?? SALES_AI_TTL_MS)
  return facts
}

export async function enrichOpportunity(
  client: SalesAiCaller,
  opportunityRef: string | number,
  opts: EnrichOptions = {},
): Promise<EnrichedEntity | null> {
  const id = numericId(opportunityRef)
  if (id == null) return null
  const fetchFacts = async (): Promise<EnrichedEntity | null> => {
    try {
      const result = await client.callTool('get_opportunity_status', { peopleai_opportunity_id: id })
      const text = extractMcpText(result)
      return text ? { text: text.slice(0, 2000), peopleaiId: id } : null
    } catch {
      return null
    }
  }
  if (!opts.cacheScope) return fetchFacts()
  const key = `sai:opp:${opts.cacheScope}:${id}`
  const hit = await cacheGet<EnrichedEntity>(key)
  if (hit) { opts.onCacheHit?.(); return hit }
  const facts = await fetchFacts()
  if (facts) await cacheSet(key, facts, opts.cacheTtlMs ?? SALES_AI_TTL_MS)
  return facts
}

/** Ask SalesAI a freeform question about an account (used by the assistant brain). */
export async function askSalesAiAboutAccount(
  client: SalesAiCaller,
  peopleaiAccountId: number,
  question: string,
): Promise<string> {
  try {
    const result = await client.callTool('ask_sales_ai_about_account', {
      peopleai_account_id: peopleaiAccountId,
      question,
    })
    return extractMcpText(result)
  } catch {
    return ''
  }
}

/** Ask SalesAI a freeform question about an opportunity. */
export async function askSalesAiAboutOpportunity(
  client: SalesAiCaller,
  peopleaiOpportunityId: number,
  question: string,
): Promise<string> {
  try {
    const result = await client.callTool('ask_sales_ai_about_opportunity', {
      peopleai_opportunity_id: peopleaiOpportunityId,
      question,
    })
    return extractMcpText(result)
  } catch {
    return ''
  }
}

/**
 * Resolve an account name to its People.ai account id via the find_account
 * tool, so custom signals can target an account the rep types by name.
 */
export async function findAccountId(client: SalesAiCaller, accountName: string): Promise<number | null> {
  try {
    const result = await client.callTool('find_account', { account_name: accountName })
    const text = extractMcpText(result)
    const match = /peopleai[_-]?account[_-]?id["\s:]+(\d+)/i.exec(text)
    return match ? Number(match[1]) : null
  } catch {
    return null
  }
}
