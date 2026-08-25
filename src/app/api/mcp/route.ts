import { NextResponse, type NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { withPublicApi } from '@/lib/server/public-api-handler'
import { handleMcpRequest, type McpTool } from '@/lib/mcp/server-protocol'
import { mcpToolsFor } from '@/lib/mcp/exposed-flows'
import { dispatchFlowExecution } from '@/features/flows/execute-flow'

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
  const tools = mcpToolsFor(flows)

  const response = await handleMcpRequest(body, {
    tools,
    invoke: async (tool: McpTool, args) => {
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
}, { scope: 'flows:execute', perMinute: 120 })

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
