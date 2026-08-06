/**
 * Agent HTTP API tools — user-configured endpoints an agent can call.
 *
 * Each tool persists the SAME config shape as a flow http step
 * (httpStepDataSchema), so the flows HTTP editor UI and the flows HTTP
 * executor are reused verbatim. Dynamic parts are declared with
 * `{{input.<name>}}` placeholders in the templated fields; the placeholder
 * set becomes the tool's JSON-schema inputs for the model (the same idea as
 * n8n's $fromAI). The `auth` subtree and credential references are NEVER
 * scanned or substituted — secrets are user-configured, not model-fillable.
 *
 * Pure module (client-safe): execution lives in ./http-tools-run.ts.
 */
import { z } from 'zod'
import { httpStepDataSchema } from '@/lib/flows/graph'
import type { ToolDefinition } from '@/lib/llm/model-runner'

export const agentHttpToolSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(60),
  description: z.string().max(500).default(''),
  config: httpStepDataSchema,
})

export type AgentHttpTool = z.infer<typeof agentHttpToolSchema>
export type AgentHttpToolConfig = z.infer<typeof httpStepDataSchema>

export const MAX_AGENT_HTTP_TOOLS = 10

/** The config fields whose strings may carry {{input.…}} placeholders. */
const TEMPLATED_FIELDS = ['url', 'query', 'headers', 'body', 'cookie', 'graphqlVariables'] as const

const PLACEHOLDER = /\{\{\s*input\.([A-Za-z_]\w*)\s*\}\}/g

/** Placeholder names across the templated fields, in first-seen order. */
export function agentHttpToolInputs(config: Partial<AgentHttpToolConfig>): string[] {
  const names: string[] = []
  for (const field of TEMPLATED_FIELDS) {
    const value = config[field]
    if (typeof value !== 'string') continue
    for (const match of value.matchAll(PLACEHOLDER)) {
      if (!names.includes(match[1])) names.push(match[1])
    }
  }
  return names
}

function toolSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'endpoint'
}

export function agentHttpToolName(tool: AgentHttpTool): string {
  return `http_${toolSlug(tool.name)}`
}

/** Model-facing tool definition: description + placeholder-derived schema. */
export function agentHttpToolDefinition(tool: AgentHttpTool): ToolDefinition {
  const inputs = agentHttpToolInputs(tool.config)
  const properties: Record<string, unknown> = {}
  for (const name of inputs) properties[name] = { type: 'string', description: `Value for {{input.${name}}} in the request.` }
  const summary = `${tool.config.method ?? 'POST'} ${tool.config.url}`.trim()
  return {
    name: agentHttpToolName(tool),
    description: [tool.description || `Call the "${tool.name}" API endpoint.`, `(${summary})`].join(' '),
    inputSchema: { type: 'object', properties, required: inputs },
  }
}

/**
 * Fill placeholders with the model's arguments (missing → ''). Returns a deep
 * copy; only TEMPLATED_FIELDS are touched, so auth/credential config can
 * never be steered by the model.
 */
export function substituteAgentHttpToolArgs(
  config: AgentHttpToolConfig,
  args: Record<string, unknown>,
): AgentHttpToolConfig {
  const next: AgentHttpToolConfig = structuredClone(config)
  const record = next as Record<string, unknown>
  for (const field of TEMPLATED_FIELDS) {
    const value = next[field]
    if (typeof value !== 'string') continue
    record[field] = value.replace(PLACEHOLDER, (_segment, name: string) => {
      const supplied = args[name]
      if (supplied === undefined || supplied === null) return ''
      if (typeof supplied === 'string') return supplied
      return JSON.stringify(supplied)
    })
  }
  return next
}

export function agentHttpToolIsWrite(config: { method?: string }): boolean {
  const method = String(config.method ?? 'POST').toUpperCase()
  return method !== 'GET' && method !== 'HEAD'
}

/** Read + validate the endpoint list from AgentTask.metadata (never throws). */
export function agentHttpToolsFromMetadata(metadata: unknown): AgentHttpTool[] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return []
  const raw = (metadata as { httpTools?: unknown }).httpTools
  if (!Array.isArray(raw)) return []
  const tools: AgentHttpTool[] = []
  for (const entry of raw.slice(0, MAX_AGENT_HTTP_TOOLS)) {
    const parsed = agentHttpToolSchema.safeParse(entry)
    if (parsed.success) tools.push(parsed.data)
  }
  return tools
}
