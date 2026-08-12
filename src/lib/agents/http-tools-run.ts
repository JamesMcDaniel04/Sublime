/**
 * Agent HTTP API tool executor — the server half of ./http-tools.ts.
 *
 * Runs a configured endpoint through the SAME machinery as a flow http step:
 * prepareHttpRequest/performHttpRequest (retries, pagination, redirects,
 * response caps) with the flow-grade SSRF guard re-run on every hop, and
 * vault credentials resolved server-side via resolveHttpCredential — the
 * secret lives only in the outbound request, never in the model transcript.
 */
import { assertEgressAllowed } from '@/lib/integrations/http'
import { assertPublicUrl } from '@/lib/net/ssrf'
import { performHttpRequest, prepareHttpRequest, type FlowHttpConfig, type HttpRequestDeps } from '@/features/flows/http'
import { applyCredentialPlan } from '@/lib/credentials/apply'
import { resolveHttpCredential } from '@/lib/credentials/resolve'
import type { McpToolClient } from '@/features/agents/tool-planes'
import { agentHttpToolName, substituteAgentHttpToolArgs, type AgentHttpTool } from './http-tools'

const MAX_RESPONSE_CHARS = 50_000

async function assertAgentHttpUrlAllowed(url: string): Promise<void> {
  assertEgressAllowed(url)
  await assertPublicUrl(url)
}

export type AgentHttpToolContext = { organizationId: string; userId?: string | null }

export async function runAgentHttpTool(
  tool: AgentHttpTool,
  args: Record<string, unknown>,
  context: AgentHttpToolContext,
  deps: HttpRequestDeps = {},
): Promise<unknown> {
  const config = substituteAgentHttpToolArgs(tool.config, args)
  const request = prepareHttpRequest(config as FlowHttpConfig)

  // Vault credential (the dialog's "generic" auth). The predefined-connection
  // mode is a flows-only concept (it rides the flow tool catalog), so a
  // stray connectionId from an import is ignored rather than half-honored.
  const credentialId = typeof config.credentialId === 'string' ? config.credentialId.trim() : ''
  if (config.authMode !== 'none' && credentialId) {
    const resolved = await resolveHttpCredential({
      credentialId,
      organizationId: context.organizationId,
      requestUrl: request.url,
      assertUrlAllowed: assertAgentHttpUrlAllowed,
    })
    const applied = applyCredentialPlan(request.url, request.init.headers as Record<string, string>, resolved.plan)
    request.url = applied.url
    request.init.headers = applied.headers
    request.runtimeAuth = resolved.runtimeAuth
    request.credentialHeaders = Object.keys(resolved.plan.headers ?? {})
  }

  const retries = Math.min(5, Math.max(0, Number(config.retries) || 0))
  const retryDelayMs = Math.min(60000, Math.max(0, Number(config.retryDelayMs) || 1000))
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, request.timeoutMs)
    try {
      return await performHttpRequest(request, {
        retryStatusCodes: config.retryStatusCodes,
        pagination: config.pagination,
        batch: config.batch,
      }, {
        assertUrlAllowed: assertAgentHttpUrlAllowed,
        signal: controller.signal,
        maxResponseChars: MAX_RESPONSE_CHARS,
        ...deps,
      })
    } catch (error) {
      lastError = timedOut ? new Error(`HTTP request timed out after ${request.timeoutMs}ms`) : error
      if (attempt < retries && retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** Adapter so a configured endpoint plugs into the agent tool dispatch loop. */
export class AgentHttpToolClient implements McpToolClient {
  constructor(private readonly tool: AgentHttpTool, private readonly context: AgentHttpToolContext) {}

  async executeTool(_serverUrl: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name !== agentHttpToolName(this.tool)) throw new Error(`Unknown endpoint tool "${name}"`)
    return runAgentHttpTool(this.tool, args ?? {}, this.context)
  }
}
