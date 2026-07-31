/**
 * Server-side run-event broadcast — the push half of run-status delivery.
 *
 * Clients watching a live run previously learned about completion only by
 * polling (2s tightening to 15s with backoff): ~30-50 req/s of pure "anything
 * change yet?" at 100 concurrent users, and still seconds of latency. This
 * module pushes a tiny "something changed" event onto the org's private
 * Realtime topic the moment a run transitions; subscribed clients react by
 * running their existing (authoritative) poll fetch immediately. Polling
 * remains as the fallback transport — a lost broadcast costs latency, never
 * correctness.
 *
 * Transport is the Realtime broadcast REST endpoint (service role): both the
 * serverless functions and the worker can send without holding a websocket.
 * Fire-and-forget with a 3s bound; a delivery failure must never block or
 * fail a run.
 */

import { apiLogger } from '@/lib/logger'

export type RunEvent = {
  kind: 'agent' | 'flow'
  /** AgentExecution id or FlowRun id. */
  runId: string
  status: string
  agentId?: string
  flowId?: string
}

export const runEventsTopic = (organizationId: string) => `run-events:${organizationId}`

function realtimeConfig(): { url: string; serviceKey: string } | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!base || !serviceKey) return null
  return { url: `${base.replace(/\/$/, '')}/realtime/v1/api/broadcast`, serviceKey }
}

/** True when this deployment can push run events (Supabase configured). */
export function runEventsConfigured(): boolean {
  return realtimeConfig() !== null
}

export function broadcastRunEvent(organizationId: string, event: RunEvent): void {
  const config = realtimeConfig()
  if (!config) return
  void fetch(config.url, {
    method: 'POST',
    headers: {
      apikey: config.serviceKey,
      Authorization: `Bearer ${config.serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: [
        {
          topic: runEventsTopic(organizationId),
          event: 'run',
          private: true,
          payload: event,
        },
      ],
    }),
    signal: AbortSignal.timeout(3_000),
  })
    .then((response) => {
      if (!response.ok) {
        apiLogger.warn('run-events: broadcast rejected', { status: response.status, organizationId })
      }
    })
    .catch((error) => {
      apiLogger.warn('run-events: broadcast failed', {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
}
