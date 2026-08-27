import { NextResponse, type NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { withPublicApi } from '@/lib/server/public-api-handler'
import { handleMcpRequest, type McpTool } from '@/lib/mcp/server-protocol'
import { mcpToolsFor } from '@/lib/mcp/exposed-flows'
import { dispatchFlowExecution } from '@/features/flows/execute-flow'
import { scopeSatisfies } from '@/lib/api-keys/keys'
import { agentDisplayName } from '@/lib/agents/metadata'
import { createAgentRequest } from '@/lib/agents/request-dispatch'
import { AGENT_REQUEST_SELECT, serializeAgentRequest } from '@/lib/agents/request-serialize'

export const runtime = 'nodejs'

/**
 * POST /api/mcp — this workspace as an MCP server.
 *
 * An external client (Claude Desktop, Cursor, another agent platform) connects
 * here and calls the workspace's exposed flows as tools. The inverse of our
 * MCP client, which consumes other people's servers.
 *
 * **Authentication reuses the workspace API key**, which is what makes this
 * safe to expose at all: the key decides the workspace, `flows:execute`
 * decides that running things is permitted, and revoking the key cuts the
 * connection. There is no separate MCP credential to leak or forget about.
 *
 * Which flows are visible is a narrower question than which are runnable
 * internally — see lib/mcp/exposed-flows.ts for why that gate is its own
 * explicit opt-in rather than reusing the internal caller policy.
 */
export const POST = withPublicApi(async (request: NextRequest, context) => {
  const body = await request.json().catch(() => null)

  const flows = await prisma.flow.findMany({
    where: { organizationId: context.organizationId },
    select: { id: true, name: true, description: true, metadata: true, publishedGraph: true },
    orderBy: { name: 'asc' },
  })
  // The reverse of BYOA: an external agent (or any MCP client) addresses a
  // Sublime agent the way a person does — the ask goes through the same
  // AgentRequest path, so the objective frames it, declines are honest, and
  // the answer lands on the request and any goal it names. Each tool is
  // ADVERTISED only to a key that may call it: listing a tool the call would
  // refuse teaches a model to retry something that can never work.
  const canAsk = scopeSatisfies(context.scopes, 'agents:execute')
  const canRead = scopeSatisfies(context.scopes, 'agents:read')
  const tools: McpTool[] = [
    ...mcpToolsFor(flows),
    ...(canAsk ? [{
      kind: 'ask_agent' as const,
      name: 'ask_agent',
      description: "Ask one of this workspace's agents to do something specific. Returns a request id; poll get_request for the answer. The agent works within its standing job and may decline an ask outside it.",
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'The agent id, or its name.' },
          text: { type: 'string', description: 'What you want it to do, in plain language.' },
        },
        required: ['agent', 'text'],
      },
    }] : []),
    ...(canRead ? [{
      kind: 'get_request' as const,
      name: 'get_request',
      description: 'The status and answer of a request made with ask_agent.',
      inputSchema: { type: 'object', properties: { requestId: { type: 'string' } }, required: ['requestId'] },
    }] : []),
  ]

  const response = await handleMcpRequest(body, {
    tools,
    invoke: async (tool: McpTool, args) => {
      if (tool.kind === 'ask_agent') {
        if (!scopeSatisfies(context.scopes, 'agents:execute')) return { ok: false as const, error: 'This API key is missing the "agents:execute" scope.' }
        const wanted = String(args.agent ?? '').trim()
        const text = String(args.text ?? '').trim()
        if (!wanted || !text) return { ok: false as const, error: 'Both agent and text are required.' }
        const candidates = await prisma.agentTask.findMany({
          where: { organizationId: context.organizationId, status: 'ACTIVE', agentType: { not: 'SYSTEM' } },
          select: { id: true, agentType: true, description: true, metadata: true },
          take: 300,
        })
        const agent = candidates.find((c) => c.id === wanted) ?? candidates.find((c) => agentDisplayName(c).toLowerCase() === wanted.toLowerCase())
        if (!agent) return { ok: false as const, error: `No agent named "${wanted}".` }
        const created = await createAgentRequest({
          organizationId: context.organizationId,
          // The key's creator is the requester. Provenance, not authorization.
          requestedByUserId: context.actingUserId,
          agent,
          text,
          origin: 'api',
        })
        return { ok: true as const, output: { requestId: created.requestId, status: 'queued', agent: agentDisplayName(agent), note: 'Poll get_request with this requestId for the answer.' } }
      }
      if (tool.kind === 'get_request') {
        if (!scopeSatisfies(context.scopes, 'agents:read')) return { ok: false as const, error: 'This API key is missing the "agents:read" scope.' }
        const row = await prisma.agentRequest.findFirst({
          where: { id: String(args.requestId ?? ''), organizationId: context.organizationId },
          select: AGENT_REQUEST_SELECT,
        })
        if (!row) return { ok: false as const, error: 'No such request.' }
        const request = serializeAgentRequest(row)
        return { ok: true as const, output: { requestId: request.id, status: request.status, agent: request.agentName, result: request.result, error: request.error } }
      }
      if (!scopeSatisfies(context.scopes, 'flows:execute')) return { ok: false as const, error: 'This API key is missing the "flows:execute" scope.' }
      const result = await dispatchFlowExecution({
        flowId: tool.flowId,
        organizationId: context.organizationId,
        // The key's creator owns the run. Provenance, not authorization — the
        // API key's scopes already decided this call is permitted.
        userId: context.actingUserId,
        input: args,
        trigger: { type: 'mcp', apiKeyId: context.apiKeyId },
      } as never, { background: false })

      // A queued run has no output yet. An MCP call is request/response, so
      // saying so plainly beats returning an empty result the model would
      // read as "the tool did nothing".
      if ('queued' in result) {
        return { ok: true as const, output: `The flow was queued (run ${result.flowRunId}).` }
      }
      return result.status === 'succeeded'
        ? { ok: true as const, output: result.output }
        : { ok: false as const, error: result.error ?? 'The flow failed.' }
    },
  })

  // A notification gets no body: answering one is a protocol violation, and
  // 202 is what the Streamable HTTP transport expects for an accepted
  // message that has no reply.
  if (response === null) return new NextResponse(null, { status: 202 })

  // Always 200, even for a JSON-RPC error: the transport succeeded, and the
  // error lives in the envelope. An HTTP error status here makes clients
  // report a connection failure instead of showing the actual problem.
  return NextResponse.json(response)
}, { scope: ['flows:execute', 'agents:execute'], perMinute: 120 })

/**
 * GET is how some clients probe the endpoint before connecting.
 *
 * SSE is not implemented — a flow call returns once, so there is nothing to
 * stream, and a half-supported transport is worse than a clearly absent one.
 * 405 with Allow is the honest answer, and it tells a client to use POST.
 *
 * Requires the SAME scope as POST, deliberately. It first required
 * `flows:read`, which meant a client holding a perfectly valid `flows:execute`
 * key got 403 on the probe and reported a connection failure — `write` implies
 * `read` in our scope model, but `execute` does not. One endpoint asking for
 * two different scopes depending on the verb is a trap.
 */
export const GET = withPublicApi(async () => {
  return NextResponse.json(
    { error: 'This MCP endpoint accepts POST (Streamable HTTP). Server-sent events are not supported.' },
    { status: 405, headers: { allow: 'POST' } },
  )
}, { scope: 'flows:execute' })
