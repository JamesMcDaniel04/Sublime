import { prisma } from '@/lib/prisma'
import { agentReadScope, flowReadScope } from '@/lib/server/visibility'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { loadFlowToolCatalog, type FlowToolCatalogConnection } from '@/lib/flows/tool-catalog'
import { outputFieldsFromJsonSchema } from '@/lib/flows/schema-fields'
import { inputParamsFromGraph, outputFieldsFromGraph, flowToolGroundingLine } from '@/lib/flows/flow-tool'
import { flowGraphSchema } from '@/lib/flows/graph'
import { listEligiblePatterns } from '@/lib/behavior/eligibility'
import { goalGroundingBlock } from '@/lib/goals/grounding'

function toolInputHint(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return ''
  const shape = schema as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] }
  const props = Object.entries(shape.properties ?? {}).slice(0, 8)
  if (!props.length) return ''
  const required = new Set(shape.required ?? [])
  return props.map(([name, prop]) => `${name}${required.has(name) ? '*' : ''}:${prop.type ?? 'any'}`).join(', ')
}

function toolOutputHint(schema: unknown): string {
  const fields = outputFieldsFromJsonSchema(schema, 8)
  return fields.map((field) => `${field.name}:${field.type}`).join(', ')
}

export const graphRules =
  'You design runnable workflow graphs for Sublime. Return a single JSON object with one property, graphJson: a JSON string containing the flow graph, shaped as {"nodes": [...], "edges": [...]}. ' +
  'Always include one trigger node with id "trigger". Prefer deterministic tool nodes for concrete integration actions and agent nodes for reasoning/writing decisions. ' +
  'Allowed node types: agent, tool, http, code, transform, filter, condition, switch, router, loop, parallel, errorShield, stop, variable, data, humanReview, input, output, subflow. ' +
  'If the flow expects named input fields, put them on the trigger as data.trigger.inputFields: [{name,type,description}]. ' +
  'Agent data: {agentId, label, input}; agentId MUST be from the agent roster. ' +
  'Tool data: {connectionId, toolName, label, args, retries, timeoutMs}; connectionId/toolName MUST be from available tools and args MUST be a JSON object string. Use retries for flaky external actions and timeoutMs for slow tools. ' +
  'For required tool args that should come from the run form, declare trigger inputFields and map args to {{trigger.input.fieldName}}. ' +
  'HTTP data: {method,url,query,headers,bodyMode,responseType,failOnHttpError,retries,timeoutMs,body}; method is GET/POST/PUT/PATCH/DELETE, query/headers/body are JSON strings, bodyMode is json/text/none, responseType is auto/json/text. ' +
  'HTTP output is an object with ok, status, statusText, url, headers, body, and bodyText; use {{step.<httpNodeId>.output.body}} for parsed API response data and {{step.<httpNodeId>.output.status}} for status checks. ' +
  'Variable data: {op, name, varType, value}; op is initialize/set/increment/decrement/appendArray/appendString; initialize declares the variable (free name, varType one of boolean/integer/float/string/object/array, optional starting value) and MUST come before any mutation of that name; varType is only for initialize; value is templated and optional for increment/decrement (defaults to 1); read a variable anywhere with {{var.<name>}}. ' +
  'Data (data operation) node data: {op, input, separator, schema, clauses, fields}; op is compose/parseJson/join/csvTable/htmlTable/filterArray/select; input is templated and usually an exact {{step.<nodeId>.output}} token so structure survives; separator is join-only; schema is parseJson-only (optional, stored for reference); clauses is filterArray-only (left/op/right evaluated per item against {{item.*}}); fields is select-only ([{name,value}] with {{item.*}} values). Prefer data nodes over transform/filter for new graphs. ' +
  'Code data: {language, mode, code, input, timeoutMs}; language is javascript/python, mode is allItems/eachItem; the code runs server-side against the item list (input is an optional template, default = previous step output; an array IS the item list). JavaScript sees $input.all()/$input.item plus items/item and supports await; Python sees _items/_item, sync only, no package imports. End with an explicit return; the returned JSON-serializable value is the step output. Prefer a code step over an agent for deterministic reshaping/math/parsing beyond what data nodes cover. ' +
  'HumanReview data: {message, assigneeUserId}; message (required, templated) is the question asked; the run pauses at this step until the person replies and the reply becomes {{step.<nodeId>.output}}; omit assigneeUserId to ask the flow owner. ' +
  'Use data references only when needed: {{trigger.input}}, {{step.<nodeId>.output}}, {{step.<nodeId>.output.field}}, {{item}}, {{item.field}}, {{loop.index}}, {{var.<name>}}. ' +
  'For loops, data.over should point at a list and data.body should contain nested node ids. For condition/filter, use data.clauses with left/op/right. ' +
  'Edges connect node ids; condition edges use branch "true"/"false"; switch edges use case ids or "default". ' +
  'Input node data: {params:[{name,type,required,default,description}]} declares the flow\'s typed callable parameters; type is one of string/number/boolean/object/array/any; read a param anywhere with {{input.<name>}}. A flow without an Input node keeps opaque {{trigger.input}}. ' +
  'Output node data: {fields:[{name,type,value,description}]} declares the flow\'s typed return object; each value is a templated binding coerced to type; a flow without an Output node returns its last step output. ' +
  'Subflow node data: {flowId,input,onError,outputFields}; flowId is a callable flow from the list below; input is a JSON object string mapping the child flow\'s input params to templated values; the step output is the child flow\'s output object (read {{step.<subflowNodeId>.output.<field>}}). Use a subflow inside a For each body to iterate a flow per item. ' +
  'Router node data: {input, instructions, branches:[{id,label,description}]}; an AI picks ONE branch from the input + each branch description. Route edges by branch = the branch id, plus a "default" edge fallback. Give every branch a clear description so the AI can route. Use a router (not switch) when the choice needs judgment rather than a literal comparison. ' +
  'Agent inline-prompt mode: leave agentId empty and set {prompt, model} to run a one-shot prompt with no saved agent (model optional; e.g. claude-haiku-4-5 for cheap classification). Use a saved agentId when the step needs tools/memory; use an inline prompt for a quick reasoning/extraction step. ' +
  'Loop threading: set loop.data.threadAgent true to keep ONE agent conversation across iterations (the agent remembers earlier items); this forces sequential execution. Omit it for independent per-item runs. ' +
  'Parallel join: parallel.data.join is object (default: keyed by branch), array (outputs in branch order), or merge (shallow-merge branch objects); parallel.data.labels names the branches for join=object. ' +
  'Error shield node data: {body:[...ids], fallback:[...ids]}; runs body, and on a body FAILURE runs fallback instead (the caught error is {{error}}). Use it to wrap risky steps with a recovery path. Branching nodes (condition/switch/router) and Input/Output cannot go inside body/fallback. ' +
  'When a later step references {{step.<agentNodeId>.output.<field>}}, that agent node MUST set responseFormat: "structured" and declare outputFields: [{name,type}] matching the referenced fields. ' +
  'Slack trigger: trigger data {type:"slack", events:[…], command?, channels?, keyword?, threadMemory?}; events is a non-empty subset of app_mention/message.im/message.channels/slash_command; slash_command requires command (e.g. "/deploy"); the Slack message arrives as {{trigger.input.text}} with {{trigger.input.channel}}, {{trigger.input.user}}, {{trigger.input.ts}}; set threadMemory true for multi-turn thread conversations.'

export async function buildCopilotGrounding(
  organizationId: string,
  userId: string,
): Promise<{
  roster: { id: string; name: string }[]
  toolCatalog: FlowToolCatalogConnection[]
  contextBlock: string
  graphRules: string
}> {
  // One batch: patterns + goals used to run in a second Promise.all AFTER this
  // one, serializing 20-60ms (more when the tool catalog is cold) for no reason
  // — none of the five reads depend on another.
  const [agents, toolCatalog, callableFlows, userPatterns, goalsBlock] = await Promise.all([
    prisma.agentTask.findMany({
      where: { organizationId, status: 'ACTIVE', ...agentReadScope(userId) },
      select: { id: true, description: true, metadata: true },
      take: 100,
    }),
    loadFlowToolCatalog(organizationId, { userId, takeConnections: 25, takeTools: 100 }),
    prisma.flow.findMany({
      // Same authorization as loadFlowPlaneGroups: published flows within the
      // user's read scope (the metadata.agentCallable gate is gone — nothing
      // ever wrote it, so this list always grounded to zero flows).
      where: { organizationId, status: 'ACTIVE', ...flowReadScope(userId) },
      select: { id: true, name: true, graph: true, publishedGraph: true },
      take: 50,
    }),
    // Evidence-gated behavior patterns (spec §5.2): generated flows should
    // match how this user actually works. Best-effort — never throws.
    listEligiblePatterns(organizationId, userId),
    goalGroundingBlock(organizationId, userId),
  ])
  const roster = agents
    .map((agent) => ({ id: agent.id, name: readAgentMetadata(agent.metadata).title || agent.description }))
    .filter((entry) => entry.name)
  const tools = toolCatalog.flatMap((connection) =>
    connection.tools.map((tool) => ({
      connectionId: connection.id,
      connectionName: connection.name,
      name: tool.name,
      description: tool.description,
      inputHint: toolInputHint(tool.inputSchema),
      outputHint: toolOutputHint(tool.outputSchema),
    })),
  )
  const flowLines = callableFlows
    .map((flow) => {
      const parsed = flowGraphSchema.safeParse(flow.publishedGraph ?? flow.graph)
      if (!parsed.success) return null
      return flowToolGroundingLine(flow, inputParamsFromGraph(parsed.data), outputFieldsFromGraph(parsed.data))
    })
    .filter((line): line is string => Boolean(line))
  const patternLines = userPatterns.slice(0, 6).map((p) => `- ${p.summary} (observed ${p.occurrenceCount}x)`)
  const patternsBlock = patternLines.length
    ? ['', '', 'How this user actually works (observed, evidence-gated — prefer flows that match these habits):', ...patternLines].join('\n')
    : ''
  const contextBlock = [
    `Agents:\n${roster.map((entry) => `- ${entry.name} (id: ${entry.id})`).join('\n') || '- None available'}`,
    '',
    `Tools:\n${tools.map((tool) => `- ${tool.connectionName}: ${tool.name} (connectionId: ${tool.connectionId})${tool.inputHint ? ` args: ${tool.inputHint}` : ''}${tool.outputHint ? ` outputs: ${tool.outputHint}` : ''}${tool.description ? ` — ${tool.description}` : ''}`).join('\n') || '- None available'}`,
    '',
    `Callable flows (agent -> flow, subflow):\n${flowLines.join('\n') || '- None available'}`,
  ].join('\n') + patternsBlock + (goalsBlock ? `\n\n${goalsBlock}` : '')
  return { roster, toolCatalog, contextBlock, graphRules }
}
