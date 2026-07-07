/**
 * One-time (re-runnable) graph-RAG backfill for an organization.
 *
 * Indexing normally fills forward from new signals/runs/agent-saves. Backfill
 * seeds the graph from what already exists:
 *   1. Sales AI book — top_records → account + opportunity nodes, enriched with
 *      get_account_status / get_opportunity_status (the org's real book of
 *      business, the highest-value seed).
 *   2. Agents, executions, and signals already in the database.
 *
 * Idempotent (stable node ids upsert in place) and gated on ragEnabled(). Safe
 * to run repeatedly; bounded by caps so a huge org can't run unbounded.
 */

import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { getPeopleAiServiceClient } from '@/lib/peopleai/client'
import { enrichAccount, enrichOpportunity, extractMcpText } from '@/lib/peopleai/salesai-facts'
import { commitGraph, nodeIds, type PendingNode } from './indexer'
import { ragEnabled } from './get-store'
import type { GraphEdge } from './store'

export interface BackfillResult {
  accounts: number
  opportunities: number
  agents: number
  executions: number
  signals: number
  skipped?: string
}

const CAPS = { accounts: 50, oppsPerAccount: 20, agents: 200, executions: 300, signals: 500 }

interface TopAccount {
  peopleai_account_id?: number
  name?: string
  domain?: string
  opportunities?: Array<{
    peopleai_opportunity_id?: number
    opportunity_name?: string
    amount?: number
    close_date?: string
    engagement_level?: number
    type?: string
    owner?: { name?: string }
  }>
}

const clip = (text: string, max = 1500) => (text.length > max ? text.slice(0, max) : text)
const safe = (value: unknown) => { try { return typeof value === 'string' ? value : JSON.stringify(value ?? {}) } catch { return '' } }

/** Build the org's Sales AI book (accounts + opportunities) as nodes/edges, enriched. */
async function buildSalesAiBook(organizationId: string): Promise<{ nodes: PendingNode[]; edges: GraphEdge[]; accounts: number; opportunities: number }> {
  // Tighter per-call ceiling for bulk work: an unresponsive Sales AI endpoint
  // must not turn a backfill into hundreds of 30s timeouts (the failure mode
  // that stalled the first run for ~1h). 15s also leaves the one-shot
  // top_records read comfortable headroom while keeping the loop fail-fast.
  const BULK_TIMEOUT_MS = 15_000
  const client = getPeopleAiServiceClient({ timeoutMs: BULK_TIMEOUT_MS })
  if (!client) return { nodes: [], edges: [], accounts: 0, opportunities: 0 }

  // Circuit breaker: stop enriching after repeated TIMEOUTS (a slow/unresponsive
  // endpoint) and fall back to basic nodes, so the book build can't become
  // hundreds of serial timeouts. Crucially, a *fast* null is just "no Sales AI
  // data for this entity" and must NOT trip the breaker — otherwise a few
  // data-sparse accounts would disable enrichment for the whole book. We tell
  // them apart by elapsed time, because enrichAccount/enrichOpportunity swallow
  // errors and always return null-or-facts (never throw), so null alone is
  // ambiguous. Only a null that took ~the full timeout counts as a failure.
  const FAILURE_LIMIT = 5
  const TIMEOUT_FLOOR_MS = BULK_TIMEOUT_MS - 1_000
  let consecutiveTimeouts = 0
  let enrichmentDisabled = false
  // The breaker judges LIVE calls only: a cache hit returns in ~ms and says
  // nothing about live-endpoint health, so it must be neutral (neither reset nor
  // count) — otherwise interleaved hits would keep resetting the counter and the
  // breaker could never trip.
  const tryEnrich = async <T>(run: (hooks: { onCacheHit: () => void }) => Promise<T | null>): Promise<T | null> => {
    if (enrichmentDisabled) return null
    let fromCache = false
    const start = Date.now()
    const result = await run({ onCacheHit: () => { fromCache = true } }).catch(() => null)
    if (!fromCache) {
      const timedOut = result == null && Date.now() - start >= TIMEOUT_FLOOR_MS
      if (timedOut) {
        if (++consecutiveTimeouts >= FAILURE_LIMIT) {
          enrichmentDisabled = true
          apiLogger.warn('backfill: Sales AI enrichment disabled after repeated timeouts', { organizationId, failures: consecutiveTimeouts })
        }
      } else {
        consecutiveTimeouts = 0
      }
    }
    return result
  }

  let records: TopAccount[] = []
  try {
    records = JSON.parse(extractMcpText(await client.callTool('top_records', {}))) as TopAccount[]
  } catch (error) {
    apiLogger.warn('backfill.top_records failed', { error: error instanceof Error ? error.message : String(error) })
    return { nodes: [], edges: [], accounts: 0, opportunities: 0 }
  }
  if (!Array.isArray(records)) return { nodes: [], edges: [], accounts: 0, opportunities: 0 }

  const nodes: PendingNode[] = []
  const edges: GraphEdge[] = []
  let accounts = 0
  let opportunities = 0

  for (const account of records.slice(0, CAPS.accounts)) {
    const acctId = account.peopleai_account_id
    if (acctId == null) continue
    const acctKey = String(acctId)
    const facts = await tryEnrich((hooks) => enrichAccount(client, acctId, { cacheScope: `org:${organizationId}`, onCacheHit: hooks.onCacheHit }))
    nodes.push({
      id: nodeIds.account(acctKey), type: 'account',
      text: facts?.text
        ? `Account: ${account.name ?? acctKey} (${account.domain ?? ''}). Sales AI status: ${facts.text}`
        : `Account: ${account.name ?? acctKey} (${account.domain ?? ''})`,
      props: { peopleaiAccountId: acctId, name: account.name, domain: account.domain },
    })
    accounts++
    for (const opp of (account.opportunities ?? []).slice(0, CAPS.oppsPerAccount)) {
      const oppId = opp.peopleai_opportunity_id
      if (oppId == null) continue
      const oppKey = String(oppId)
      const oppFacts = await tryEnrich((hooks) => enrichOpportunity(client, oppId, { cacheScope: `org:${organizationId}`, onCacheHit: hooks.onCacheHit }))
      const base = `Opportunity: ${opp.opportunity_name ?? oppKey} — $${opp.amount ?? '?'}, closes ${opp.close_date ?? '?'}, engagement ${opp.engagement_level ?? '?'}, owner ${opp.owner?.name ?? '?'}`
      nodes.push({
        id: nodeIds.opportunity(oppKey), type: 'opportunity',
        text: oppFacts?.text ? `${base}. Sales AI status: ${oppFacts.text}` : base,
        props: {
          peopleaiOpportunityId: oppId, name: opp.opportunity_name, amount: opp.amount,
          closeDate: opp.close_date, engagementLevel: opp.engagement_level, owner: opp.owner?.name,
        },
      })
      edges.push({ organizationId, from: nodeIds.opportunity(oppKey), to: nodeIds.account(acctKey), rel: 'belongs_to' })
      opportunities++
    }
  }
  return { nodes, edges, accounts, opportunities }
}

/**
 * Backfill collects ALL nodes across the Sales AI book + existing agents/runs/
 * signals and embeds them in a few batched requests (not one-per-item), so it
 * stays within the embeddings provider's rate limit. Idempotent; re-runnable.
 */
export async function backfillOrganization(organizationId: string): Promise<BackfillResult> {
  if (!ragEnabled()) {
    return { accounts: 0, opportunities: 0, agents: 0, executions: 0, signals: 0, skipped: 'rag-disabled' }
  }

  const book = await buildSalesAiBook(organizationId)
  const nodes: PendingNode[] = [...book.nodes]
  const edges: GraphEdge[] = [...book.edges]

  const agents = await prisma.agentTask.findMany({
    where: { organizationId, status: { not: 'DELETED' } }, take: CAPS.agents, orderBy: { createdAt: 'desc' },
  })
  for (const agent of agents) {
    const meta = (agent.metadata && typeof agent.metadata === 'object' ? agent.metadata : {}) as Record<string, unknown>
    const title = (meta.title as string) || agent.description?.split('\n')[0] || 'Untitled agent'
    nodes.push({
      id: nodeIds.agent(agent.id), type: 'agent',
      text: clip(`Agent "${title}". ${agent.description ?? ''} Objective: ${agent.objective ?? ''}`, 1200),
      props: { agentId: agent.id, title },
      ownerUserId: agent.userId ?? null,
      visibility: agent.visibility === 'private' ? 'private' : 'shared',
    })
  }

  const executions = await prisma.agentExecution.findMany({
    where: { organizationId, status: 'completed' }, take: CAPS.executions, orderBy: { startedAt: 'desc' },
    omit: { transcript: true },
    // Runs inherit their agent's scope so a private agent's runs stay private.
    include: { agentTask: { select: { userId: true, visibility: true } } },
  })
  for (const execution of executions) {
    nodes.push({
      id: nodeIds.run(execution.id), type: 'run',
      text: clip(`Agent run (${execution.status}). Output: ${safe(execution.output)}`, 1500),
      props: { status: execution.status, agentTaskId: execution.agentTaskId },
      ownerUserId: execution.agentTask?.userId ?? null,
      visibility: execution.agentTask?.visibility === 'private' ? 'private' : 'shared',
    })
    if (execution.agentTaskId) edges.push({ organizationId, from: nodeIds.run(execution.id), to: nodeIds.agent(execution.agentTaskId), rel: 'ran_agent' })
    if (execution.signalId) edges.push({ organizationId, from: nodeIds.signal(execution.signalId), to: nodeIds.run(execution.id), rel: 'triggered_run' })
  }

  const signals = await prisma.signal.findMany({ where: { organizationId }, take: CAPS.signals, orderBy: { receivedAt: 'desc' } })
  for (const signal of signals) {
    nodes.push({
      id: nodeIds.signal(signal.id), type: 'signal',
      text: clip(`Sales AI signal: ${signal.type}. ${safe(signal.payload)}`, 1500),
      props: { signalType: signal.type, accountId: signal.accountId, opportunityId: signal.opportunityId },
    })
    if (signal.accountId) edges.push({ organizationId, from: nodeIds.signal(signal.id), to: nodeIds.account(signal.accountId), rel: 'about_account' })
    if (signal.opportunityId) edges.push({ organizationId, from: nodeIds.signal(signal.id), to: nodeIds.opportunity(signal.opportunityId), rel: 'about_opportunity' })
  }

  // Dedupe nodes by id (book entities win over signal-derived stubs).
  const byId = new Map<string, PendingNode>()
  for (const node of nodes) if (!byId.has(node.id)) byId.set(node.id, node)
  const deduped = [...byId.values()]

  // Embed + persist in batches of 64 so we make few embeddings requests.
  for (let i = 0; i < deduped.length; i += 64) {
    await commitGraph(organizationId, deduped.slice(i, i + 64), [])
  }
  if (edges.length) await commitGraph(organizationId, [], edges)

  const result: BackfillResult = {
    accounts: book.accounts, opportunities: book.opportunities,
    agents: agents.length, executions: executions.length, signals: signals.length,
  }
  apiLogger.info('rag backfill complete', { organizationId, ...result })
  return result
}
