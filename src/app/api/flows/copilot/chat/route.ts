import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordUserEvent } from '@/lib/behavior/record-event'
import { checkMonthlyTokenBudget } from '@/lib/usage/budget'
import { meterTokens } from '@/lib/usage/meter'
import { createModelRunner } from '@/lib/llm/model-runner'
import { runCopilotLoop, type CopilotStreamEvent } from '@/lib/llm/copilot-loop'
import { sseResponse } from '@/lib/server/sse'
import { buildFlowCopilotTools, EDIT_FLOW_TOOL } from '@/lib/flows/copilot-tools'
import { flowGraphSchema, emptyGraph } from '@/lib/flows/graph'
import { validateFlowGraph } from '@/lib/flows/validate'
import { buildCopilotGrounding } from '@/lib/flows/copilot-grounding'
import { applyCopilotOps } from '@/lib/flows/copilot-ops'
import { parseCopilotChatReply, sanitizeCopilotOps, sanitizeDemoRun, discardNotice } from '@/lib/flows/copilot-chat'

// Structured-output calls are bounded at ~100s (structuredCallDeadlineMs);
// without an explicit maxDuration the platform default can kill the request
// BEFORE that deadline yields a clean, catchable error - the user saw a raw 504.
export const maxDuration = 120

// The {message, opsJson} shape now lives on EDIT_FLOW_TOOL.inputSchema — the
// model emits it as a terminal tool call at the end of the read-tool loop.
// The ops-array-as-JSON-string wrapper survives for the same reason as ever:
// strict schemas can't express the six heterogeneous op shapes.
const OPS_CONTRACT = [
  'EDIT OPERATIONS',
  'You are editing an existing flow conversationally. The graph shape rules above govern node/edge CONTENT (including the graph inside a replace op). When you decide on changes, call the edit_flow tool ONCE with {message, opsJson}; opsJson is a JSON string containing an ARRAY of edit operations (use "[]" when you change nothing).',
  'The six allowed operations:',
  '- {"op": "add", "type": "agent" | "code" | "condition" | "loop" | "parallel" | "stop" | "tool" | "http" | "transform" | "filter" | "switch" | "variable" | "data" | "humanReview", "afterId": "<existing node id>", "agentId": "<roster agent id, agent steps only>", "data": { ...node data fields... }} — insert a new step after afterId.',
  '- {"op": "update", "id": "<node id>", "data": { ...fields to merge... }} — shallow-merge data into an existing step.',
  '- {"op": "delete", "id": "<node id>"} — remove a step.',
  '- {"op": "move", "id": "<node id>", "afterId": "<node id>"} — move a step to sit after another.',
  '- {"op": "setTrigger", "trigger": { ...trigger config fields... }} — merge changes into the trigger configuration.',
  '- {"op": "replace", "graphJson": "<the complete flow graph as a JSON string, same shape rules as generation>"} — replace the entire flow.',
  'Prefer minimal targeted ops over replace. Use replace ONLY when building a brand-new flow or when the user explicitly asks for a full redesign.',
  'When the request is ambiguous or impossible with these operations, call edit_flow with opsJson "[]" and ask ONE clarifying question in message.',
  'Always explain what you did or what you need in message, mentioning node labels.',
  'You also have read-only lookup tools (list_flow_runs, get_flow_run, get_tool_schema, get_flow, list_flow_connections) — at most 6 lookups per turn. Use them to check run failures, exact tool argument schemas, connection health, and other flows instead of guessing.',
  '',
  'DEMO RUNS (sample data, no credentials needed)',
  'When connections are missing or the user wants to see end-to-end output before connecting anything, offer a DEMO RUN: pass demoMocksJson on the SAME edit_flow call — a JSON object keyed by node id with a realistic sample output per step. Rules:',
  '- Mock EVERY step whose connection is missing/unverified AND every write step (Slack posts, emails, CRM writes, non-GET HTTP) so the demo never sends anything real. Check list_flow_connections first.',
  '- Make sample outputs realistic and shaped like the real thing (use get_tool_schema outputSchema when available). Downstream unmocked steps (conditions, code, transforms, inline agents) will run for REAL against your samples.',
  '- If the flow declares input fields, also pass demoInputJson with realistic trigger input values.',
  '- Demo runs only work on a SAVED flow. In your message, tell the user what the demo will show, and afterwards which integrations to connect (name them) to make it real.',
  'Never claim you used real or dummy credentials — a demo run uses sample data, and the message must say so plainly.',
].join('\n')

const requestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().transform((content) => content.slice(0, 4000)),
      }),
    )
    .min(1)
    .max(20),
  graph: z.unknown(),
  // The saved flow being edited, when there is one — grounds the read tools'
  // "runs of this flow" default. Absent for a brand-new unsaved canvas.
  flowId: z.string().optional(),
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  // Copilot chat is a full LLM call — rate limiting lives in the wrapper
  // (`flow-copilot`, perUser 30); the budget check and grounding are
  // independent reads, so they run in parallel off the hot path.
  const { messages, graph: rawGraph, flowId } = requestSchema.parse(await request.json())
  const [budget, grounding] = await Promise.all([
    checkMonthlyTokenBudget(auth.organizationId, auth.dbUser.id),
    buildCopilotGrounding(auth.organizationId, auth.dbUser.id),
  ])
  if (budget.over) throw new ApiError('Monthly token budget reached for this workspace.', 429, 'BUDGET_EXCEEDED')
  // Behavior capture: the ask itself, by reference only (no prompt text).
  //
  // Awaited deliberately. This was briefly fire-and-forget for latency, but a
  // floating promise is not durable here: the response can be returned and the
  // request torn down before the insert lands, so prompts went unrecorded —
  // and the capture-before-the-LLM-call contract (the ask survives even when
  // the model call fails or times out) silently became a race. One indexed
  // insert ahead of a multi-second model call is not the latency to optimise.
  // Failures still never break the user's turn.
  await recordUserEvent({
    organizationId: auth.organizationId, userId: auth.dbUser.id,
    kind: 'copilot_prompt', resourceType: 'flow', resourceId: null,
    context: { turns: messages.length },
  }).catch(() => undefined)
  const { roster, toolCatalog, contextBlock, graphRules } = grounding

  // An invalid/missing graph means we're chatting over a blank canvas.
  const parsedGraph = flowGraphSchema.safeParse(rawGraph)
  const graph = parsedGraph.success ? parsedGraph.data : emptyGraph()

  // Connection-health grounding: which of THIS graph's steps point at
  // connections the workspace doesn't have. Costs nothing extra (the catalog
  // is already loaded) and lets the copilot proactively offer demo runs and
  // name exactly what to connect.
  const catalogIds = new Set(toolCatalog.map((connection) => connection.id))
  const missingLines = graph.nodes.flatMap((node) => {
    if ((node.type !== 'tool' && node.type !== 'http') || !node.data.connectionId) return []
    if (catalogIds.has(node.data.connectionId)) return []
    const label = (node.data as { label?: string }).label?.trim() || node.type
    return [`- Step "${label}" (${node.id}) uses ${node.data.connectionId} — NOT connected in this workspace.`]
  })
  const missingBlock = missingLines.length
    ? `\n\nMissing connections in the current flow:\n${missingLines.join('\n')}`
    : ''

  const system = [graphRules, '', OPS_CONTRACT, '', contextBlock + missingBlock].join('\n')
  const transcriptText = messages.map((entry) => `${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.content}`).join('\n\n')
  const user = [
    `Current flow graph JSON:\n${JSON.stringify(graph)}`,
    '',
    `Conversation so far:\n${transcriptText}`,
    '',
    'Respond to the latest user message.',
  ].join('\n')

  const runTurn = async (emit: (event: CopilotStreamEvent) => void) => {
    // The runner caches the system prefix per provider call (see model-runner's
    // cache_control) — the graph rules + ops contract + grounding block repeat
    // verbatim across a session's turns.
    const runner = createModelRunner()
    const transcript = runner.start(user)
    const loop = await runCopilotLoop({
      runner,
      system,
      transcript,
      readTools: buildFlowCopilotTools({ organizationId: auth.organizationId, userId: auth.dbUser.id, currentFlowId: flowId ?? null, graph }),
      terminalTool: EDIT_FLOW_TOOL,
      emit,
    })
    // Real usage summed across the loop's hops — the old chars/4 estimate is gone.
    void meterTokens({ organizationId: auth.organizationId, tokens: loop.usage.inputTokens + loop.usage.outputTokens, path: '/api/flows/copilot/chat', estimated: false })

    // Terminal call → the same sanitize/apply/validate pipeline as before. A
    // pure-Q&A turn (no terminal call) is a no-op edit with the prose as the
    // message.
    const terminal = loop.terminalCall as { message?: string; opsJson?: string; demoMocksJson?: string; demoInputJson?: string } | null
    const reply = terminal
      ? parseCopilotChatReply(JSON.stringify({
          message: terminal.message ?? '',
          opsJson: terminal.opsJson ?? '[]',
          ...(terminal.demoMocksJson ? { demoMocksJson: terminal.demoMocksJson } : {}),
          ...(terminal.demoInputJson ? { demoInputJson: terminal.demoInputJson } : {}),
        }))
      : { message: loop.text.trim(), candidates: [] as unknown[], opsUnreadable: false }
    const { ops, discarded } = sanitizeCopilotOps(reply.candidates, { agents: roster, toolCatalog })
    const totalDiscarded = discarded + (reply.opsUnreadable ? 1 : 0)

    // Apply the sanitized ops server-side so needsAttention reflects the
    // post-edit state the client will land on — and so the fallback message
    // is honest about whether anything actually applied.
    const applied = applyCopilotOps(graph, ops)
    const baseMessage =
      reply.message ||
      (ops.length === 0
        ? 'I could not work out a change to make — could you rephrase?'
        : applied.applied === 0
          ? 'I could not apply those changes — the targets may no longer exist.'
          : 'I applied the requested changes.')
    let message = totalDiscarded > 0 ? baseMessage + discardNotice(totalDiscarded) : baseMessage
    // Fires even when nothing applied but the model supplied its own (possibly
    // optimistic) message — the applied===0 fallback only covers the no-message case.
    if (applied.skipped.length > 0 && (applied.applied > 0 || reply.message)) {
      message += ` (${applied.skipped.length} change${applied.skipped.length === 1 ? '' : 's'} could not be applied.)`
    }
    const validation = validateFlowGraph(applied.graph, {
      agents: roster.map((agent) => ({ id: agent.id, title: agent.name })),
      toolCatalog,
      requireRunnable: applied.graph.nodes.length > 1,
    })
    const needsAttention = [...validation.errors, ...validation.warnings].map((issue) => ({ nodeId: issue.nodeId, message: issue.message }))

    // A copilot-authored demo run: sanitized against the POST-ops graph so
    // mock keys always reference steps that exist. Only meaningful on a saved
    // flow — the client needs a flowId to execute it.
    const demoRun = flowId
      ? sanitizeDemoRun(reply.demoMocksJson, reply.demoInputJson, applied.graph)
      : null

    return { success: true, message, ops, needsAttention, ...(demoRun ? { demoRun } : {}) }
  }

  // Content negotiation: SSE when the client asks for it, the legacy JSON
  // body otherwise. The legacy path keeps its {success:false,error} contract
  // instead of a thrown 5xx; on the SSE path a throw becomes an in-band
  // {type:'error'} event via sseResponse.
  if (request.headers.get('accept')?.includes('text/event-stream')) {
    return sseResponse(async (emit) => {
      const payload = await runTurn(emit as (event: CopilotStreamEvent) => void)
      emit({ type: 'result', ...payload })
    })
  }
  try {
    return await runTurn(() => undefined)
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Could not apply that change.',
    }
  }
}, { requires: 'member', rateLimit: { feature: 'flow-copilot', perUser: 30 } })
