import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { embeddingsConfigured } from '@/lib/rag/embeddings'
import { graphRagPersistent } from '@/lib/rag/get-store'
import { pushEnabled } from '@/lib/notifications/push'
import { nangoConfigured } from '@/lib/nango/client'
import { slackConfigured } from '@/lib/integrations/slack'
import { emailConfigured } from '@/lib/integrations/email'
import { granolaConfigured } from '@/lib/integrations/granola'
import { qwenConfigured } from '@/lib/llm/qwen'
import { EXECUTION_MODE } from '@/lib/queue/execution-mode'

/**
 * GET /api/system/capabilities — which optional platform services are live in
 * THIS deployment. Several features silently degrade when their keys are
 * absent (semantic search falls back to keyword overlap, push simply never
 * delivers, graph memory is in-process only); this endpoint makes that state
 * visible so admins see WHAT is off instead of wondering why a feature feels
 * inert. Booleans only — never key material or key fragments.
 */
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const granola = await granolaConfigured(auth.organizationId).catch(() => false)
  const capabilities = [
    {
      key: 'model.anthropic',
      label: 'Claude models',
      configured: Boolean(process.env.ANTHROPIC_API_KEY),
      detail: 'Primary model provider for agents, flows, and the copilot.',
    },
    {
      key: 'model.qwen',
      label: 'Qwen models (optional)',
      configured: qwenConfigured(),
      detail: 'Alternate model provider; agents can select Qwen when configured.',
    },
    {
      key: 'rag.semanticSearch',
      label: 'Semantic search & correlated context',
      configured: embeddingsConfigured(),
      detail: 'Without an embeddings key, knowledge search falls back to keyword matching and runs are not graph-indexed.',
    },
    {
      key: 'rag.graphStore',
      label: 'Durable graph memory',
      configured: graphRagPersistent(),
      detail: 'Without a graph database, workspace memory lives in-process and resets on deploy.',
    },
    {
      key: 'notifications.push',
      label: 'Web push notifications',
      configured: pushEnabled(),
      detail: 'Without push keys, notifications appear only in the in-app bell.',
    },
    {
      key: 'integrations.nango',
      label: 'Connected accounts (Nango)',
      configured: nangoConfigured(),
      detail: 'OAuth account connections and outbound delivery (Slack/Gmail/Salesforce writes).',
    },
    {
      key: 'integrations.slack',
      label: 'Slack (platform bot)',
      configured: slackConfigured(),
      detail: 'Workspace-level Slack tools for agents.',
    },
    {
      key: 'integrations.email',
      label: 'Email delivery',
      configured: emailConfigured(),
      detail: 'Outbound email for agents and reports.',
    },
    {
      key: 'integrations.granola',
      label: 'Granola',
      configured: granola,
      detail: 'Meeting-notes tools; configured per workspace with a Granola API key.',
    },
    {
      key: 'runtime.executionMode',
      label: EXECUTION_MODE === 'queue' ? 'Background worker (queue)' : 'Inline execution (development)',
      configured: EXECUTION_MODE === 'queue',
      detail:
        EXECUTION_MODE === 'queue'
          ? 'Agent and flow runs execute on the durable worker.'
          : 'Runs execute in the web process — fine for development, not for serverless production.',
    },
  ]
  return { success: true, capabilities }
}, { requires: 'member', rateLimit: { feature: 'capabilities', perUser: 6 } })
