/**
 * Serving MCP — this workspace's flows, exposed as tools to an external client.
 *
 * The inverse of mcp-client.ts, which consumes other people's servers. Kept
 * pure and free of Next, Prisma and the network so every protocol rule is
 * testable directly: the requests here arrive from a client we do not control,
 * and a malformed one must produce a well-formed error rather than a crash.
 *
 * Transport is plain HTTP POST of JSON-RPC 2.0, which is the Streamable HTTP
 * transport's request path. Streaming responses (SSE) are not implemented — a
 * flow call returns once, so there is nothing to stream, and a half-supported
 * transport is worse than a clearly absent one.
 */

/** The spec revision this server implements. */
export const MCP_PROTOCOL_VERSION = '2025-06-18'

const SERVER_INFO = { name: 'sublime', version: '1.0.0' }

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** Internal — never sent to the client. */
  flowId: string
}

export type InvokeResult =
  | { ok: true; output: unknown }
  | { ok: false; error: string }

export interface McpServerContext {
  tools: McpTool[]
  invoke: (tool: McpTool, args: Record<string, unknown>) => Promise<InvokeResult>
}

/**
 * Each method returns a different result shape, so the envelope carries a
 * permissive record and the caller reads the fields it knows about. Typing it
 * as a union of every method's shape would push a discriminating switch into
 * every consumer for no safety they do not already have from the method name.
 */
type McpResult = { [key: string]: unknown }

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: McpResult
  error?: { code: number; message: string }
}

// JSON-RPC 2.0 reserved codes.
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602

function ok(id: string | number | null, result: Record<string, unknown>): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function fail(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/**
 * A tool's outcome, in MCP's shape.
 *
 * `isError: true` says "the tool ran and failed", which is NOT a JSON-RPC
 * error. The distinction matters: a JSON-RPC error means the request itself
 * was bad, and a client may treat that as fatal to the session, whereas a tool
 * error is shown to the user and the conversation continues.
 */
function toolOutcome(id: string | number | null, text: string, isError: boolean): JsonRpcResponse {
  return ok(id, { content: [{ type: 'text', text }], isError })
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return JSON.stringify(value, null, 2)
}

/**
 * Handle one JSON-RPC request.
 *
 * Returns null for a NOTIFICATION (a message with no id). Answering one is a
 * protocol violation, and some clients treat an unexpected response as fatal.
 */
export async function handleMcpRequest(
  body: unknown,
  context: McpServerContext,
): Promise<JsonRpcResponse | null> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(null, INVALID_REQUEST, 'Expected a JSON-RPC request object.')
  }

  const request = body as { id?: string | number; method?: unknown; params?: unknown }
  const id = request.id ?? null
  const isNotification = request.id === undefined

  if (typeof request.method !== 'string' || !request.method) {
    return isNotification ? null : fail(id, INVALID_REQUEST, 'A method is required.')
  }

  const params = (request.params && typeof request.params === 'object' && !Array.isArray(request.params)
    ? request.params
    : {}) as Record<string, unknown>

  switch (request.method) {
    case 'initialize':
      // The client's requested version is deliberately not honoured when we do
      // not speak it: replying with ours completes the handshake and lets the
      // client decide, which beats failing with something it cannot interpret.
      return ok(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      })

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null

    case 'ping':
      return isNotification ? null : ok(id, {})

    case 'tools/list':
      return ok(id, {
        // flowId is stripped: it is an internal identifier, and handing it out
        // invites a client to address flows by id rather than by tool name.
        tools: context.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      })

    case 'tools/call': {
      const name = params.name
      if (typeof name !== 'string' || !name) {
        return fail(id, INVALID_PARAMS, 'A tool name is required.')
      }

      const tool = context.tools.find((entry) => entry.name === name)
      if (!tool) {
        // A tool error, not a protocol error — the request was well-formed.
        return toolOutcome(id, `No tool named "${name}" is available.`, true)
      }

      const args = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? params.arguments
        : {}) as Record<string, unknown>

      try {
        const outcome = await context.invoke(tool, args)
        return outcome.ok
          ? toolOutcome(id, asText(outcome.output), false)
          : toolOutcome(id, outcome.error, true)
      } catch (error) {
        // A flow that throws must not take down the client's session.
        return toolOutcome(id, error instanceof Error ? error.message : 'The tool failed.', true)
      }
    }

    default:
      return isNotification ? null : fail(id, METHOD_NOT_FOUND, `Unknown method "${request.method}".`)
  }
}
