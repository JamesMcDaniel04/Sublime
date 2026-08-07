/** Import-contract coverage for the remaining mutation surface.
 *
 * High-risk authorization/effect paths have DB-backed tests elsewhere. This
 * table closes the rest of the route gap at the module boundary: every listed
 * handler must load in the test runtime and export the verb its URL promises.
 * A missing module, bad top-level import, renamed verb, or accidental removal
 * now fails CI instead of remaining a permanent PENDING_COVERAGE exemption. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

type Verb = 'POST' | 'PUT' | 'PATCH' | 'DELETE'
type Contract = { name: string; verb: Verb; load: () => Promise<unknown> }

const contracts: Contract[] = [
  { name: 'feedback submit', verb: 'POST', load: () => import('../feedback/route') },
  { name: 'executions reply', verb: 'POST', load: () => import('../executions/[id]/reply/route') },
  { name: 'connections verify', verb: 'POST', load: () => import('../connections/verify/route') },
  { name: 'agent template update', verb: 'PUT', load: () => import('../agent-templates/route') },
  { name: 'agent template delete', verb: 'DELETE', load: () => import('../agent-templates/route') },
  { name: 'agent chat patch', verb: 'PATCH', load: () => import('../agents/[id]/chat/route') },
  { name: 'agent knowledge delete', verb: 'DELETE', load: () => import('../agents/[id]/knowledge/route') },
  { name: 'agent memory put', verb: 'PUT', load: () => import('../agents/[id]/memories/route') },
  { name: 'agent memory patch', verb: 'PATCH', load: () => import('../agents/[id]/memories/route') },
  { name: 'agent memory delete', verb: 'DELETE', load: () => import('../agents/[id]/memories/route') },
  { name: 'agent skill add', verb: 'POST', load: () => import('../agents/[id]/skills/route') },
  { name: 'agent skill delete', verb: 'DELETE', load: () => import('../agents/[id]/skills/route') },
  { name: 'agent draft', verb: 'POST', load: () => import('../agents/draft/route') },
  { name: 'flow delete', verb: 'DELETE', load: () => import('../flows/route') },
  { name: 'flow import', verb: 'POST', load: () => import('../flows/import/route') },
  { name: 'flow comment patch', verb: 'PATCH', load: () => import('../flows/[id]/comments/route') },
  { name: 'flow comment delete', verb: 'DELETE', load: () => import('../flows/[id]/comments/route') },
  { name: 'dismiss suggestion', verb: 'POST', load: () => import('../flows/[id]/dismiss-suggestion/route') },
  { name: 'flow run patch', verb: 'PATCH', load: () => import('../flows/[id]/runs/[runId]/route') },
  { name: 'flow run delete', verb: 'DELETE', load: () => import('../flows/[id]/runs/[runId]/route') },
  { name: 'flow run resubmit', verb: 'POST', load: () => import('../flows/[id]/runs/[runId]/resubmit/route') },
  { name: 'flow run webhook resume', verb: 'POST', load: () => import('../flows/[id]/runs/[runId]/resume/route') },
  { name: 'flow suggestion patch', verb: 'PATCH', load: () => import('../flows/[id]/suggestions/route') },
  { name: 'flow version patch', verb: 'PATCH', load: () => import('../flows/[id]/versions/route') },
  { name: 'flow version delete', verb: 'DELETE', load: () => import('../flows/[id]/versions/route') },
  { name: 'flow signal', verb: 'POST', load: () => import('../flows/signals/[name]/route') },
  { name: 'goal contribution delete', verb: 'DELETE', load: () => import('../goals/[id]/contributions/route') },
  { name: 'goal settings patch', verb: 'PATCH', load: () => import('../goals/settings/route') },
  { name: 'knowledge delete', verb: 'DELETE', load: () => import('../knowledge/route') },
  { name: 'notification delete', verb: 'DELETE', load: () => import('../notifications/[id]/route') },
  { name: 'notifications read', verb: 'POST', load: () => import('../notifications/read/route') },
  { name: 'organization patch', verb: 'PATCH', load: () => import('../organizations/route') },
  { name: 'organization delete', verb: 'DELETE', load: () => import('../organizations/route') },
  { name: 'profile patch', verb: 'PATCH', load: () => import('../settings/profile/route') },
  { name: 'skill put', verb: 'PUT', load: () => import('../skills/route') },
  { name: 'skill delete', verb: 'DELETE', load: () => import('../skills/route') },
  { name: 'granola delete', verb: 'DELETE', load: () => import('../integrations/granola/route') },
  { name: 'granola test', verb: 'POST', load: () => import('../integrations/granola/test/route') },
  { name: 'learning delete', verb: 'DELETE', load: () => import('../intelligence/learnings/route') },
  { name: 'intelligence rescan', verb: 'POST', load: () => import('../intelligence/rescan/route') },
  { name: 'mcp put', verb: 'PUT', load: () => import('../mcp-connections/route') },
  { name: 'mcp discover', verb: 'POST', load: () => import('../mcp-connections/discover/route') },
  { name: 'mcp test', verb: 'POST', load: () => import('../mcp-connections/test/route') },
  { name: 'nango delete', verb: 'DELETE', load: () => import('../nango/connections/[integrationId]/route') },
  { name: 'nango session', verb: 'POST', load: () => import('../nango/session-token/route') },
  { name: 'postgres test', verb: 'POST', load: () => import('../postgres/connections/[id]/test/route') },
  { name: 'push delete', verb: 'DELETE', load: () => import('../push/subscribe/route') },
  { name: 'flow copilot', verb: 'POST', load: () => import('../flows/copilot/route') },
  { name: 'goal copilot draft', verb: 'POST', load: () => import('../goals/copilot/draft/route') },
  { name: 'goal metric preview', verb: 'POST', load: () => import('../goals/metrics/preview/route') },
  { name: 'integration AI search', verb: 'POST', load: () => import('../integrations/ai-search/route') },
  { name: 'template AI search', verb: 'POST', load: () => import('../templates/ai-search/route') },
]

test('every legacy mutation-gap route loads and exports its declared handler', async () => {
  for (const contract of contracts) {
    const routeExports = await contract.load() as Record<string, unknown>
    assert.equal(typeof routeExports[contract.verb], 'function', `${contract.name} must export ${contract.verb}`)
  }
})
