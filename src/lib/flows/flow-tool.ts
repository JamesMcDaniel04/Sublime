/**
 * Flow -> ToolDefinition adapter (pure derivation).
 *
 * An agent-callable flow (metadata.agentCallable) is exposed to the agent
 * runtime as a single tool whose signature comes from the flow's first-class
 * input/output nodes (see io-nodes.ts): the input node's params become the
 * tool's typed JSON Schema arguments, and the output node's fields describe
 * what the tool returns. Everything here is a pure derivation over a parsed
 * FlowGraph — no I/O, no Prisma — so it can be unit tested directly and
 * reused by both the tool-plane loader (tool-planes.ts) and any copilot
 * grounding/prompting that wants to describe callable flows.
 */
import type { FlowGraph, FieldType, OutputField } from '@/lib/flows/graph'
import type { InputParamSpec } from '@/lib/flows/io-nodes'

/** The input node's params as a callable signature (empty when none declared). */
export function inputParamsFromGraph(graph: FlowGraph): InputParamSpec[] {
  const node = graph.nodes.find((n) => n.type === 'input')
  return node?.type === 'input'
    ? node.data.params
        .filter((p) => p.name.trim())
        .map((p) => ({
          name: p.name,
          type: p.type,
          required: p.required,
          default: p.default,
          ...(p.description ? { description: p.description } : {}),
        }))
    : []
}

/** The output node's declared fields as OutputFields (empty when none declared). */
export function outputFieldsFromGraph(graph: FlowGraph): OutputField[] {
  const node = graph.nodes.find((n) => n.type === 'output')
  return node?.type === 'output'
    ? node.data.fields
        .filter((f) => f.name.trim())
        .map((f) => ({ name: f.name, type: f.type, ...(f.description ? { description: f.description } : {}) }))
    : []
}

const JSON_SCHEMA_TYPE: Record<Exclude<FieldType, 'any'>, string> = {
  string: 'string', number: 'number', boolean: 'boolean', object: 'object', array: 'array',
}

/** Typed JSON Schema for a flow's input params — the tool's inputSchema. */
export function flowInputJsonSchema(params: InputParamSpec[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const param of params) {
    const name = param.name.trim()
    if (!name) continue
    const type = param.type ?? 'string'
    properties[name] = {
      ...(type === 'any' ? {} : { type: JSON_SCHEMA_TYPE[type] }),
      ...((param as { description?: string }).description ? { description: (param as { description?: string }).description } : {}),
    }
    if (param.required) required.push(name)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

/** Slug a flow name into a stable tool suffix (agent tool name = `flow_<slug>`). */
export function flowToolSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48) || 'flow'
}

/** One copilot-grounding line describing a callable flow's signature. */
export function flowToolGroundingLine(
  flow: { id: string; name: string },
  params: InputParamSpec[],
  outputs: OutputField[],
): string {
  const inHint = params.map((p) => `${p.name}${p.required ? '*' : ''}:${p.type ?? 'string'}`).join(', ')
  const outHint = outputs.map((f) => `${f.name}:${f.type}`).join(', ')
  return `- ${flow.name} (flowId: ${flow.id})${inHint ? ` inputs: ${inHint}` : ''}${outHint ? ` outputs: ${outHint}` : ''}`
}
