import { FIELD_TYPES, type FlowGraph, type FlowNode } from '@/lib/flows/graph'
import { literalAuthSecrets } from '@/lib/flows/inline-auth'
import { FLOW_TRIGGER_TYPES } from '@/lib/flows/trigger'
import { SLACK_EVENT_KINDS } from '@/lib/slack/payload'

export type FlowValidationIssue = {
  level: 'error' | 'warning'
  code: string
  message: string
  nodeId?: string
}

export type FlowValidationContext = {
  agents?: { id: string; title?: string }[]
  toolCatalog?: {
    id: string
    name?: string
    tools?: { name: string; inputSchema?: unknown; schemaHash?: string; risk?: 'read' | 'write' | 'destructive' }[]
    verification?: { state: 'verified' | 'stale' | 'failed' | 'unverified'; error?: string }
  }[]
  requireRunnable?: boolean
}

export type FlowValidationResult = {
  ok: boolean
  errors: FlowValidationIssue[]
  warnings: FlowValidationIssue[]
  issues: FlowValidationIssue[]
}

/** Exported for node-test-input's NodeRef labels — one label derivation, not two. */
export function nodeLabel(node: FlowNode | undefined) {
  if (!node) return 'Unknown step'
  const label = 'label' in node.data && typeof node.data.label === 'string' ? node.data.label.trim() : ''
  if (label) return label
  switch (node.type) {
    case 'trigger':
      return 'Trigger'
    case 'agent':
      return 'Run agent'
    case 'tool':
      return 'Tool call'
    case 'http':
      return 'HTTP request'
    case 'loop':
      return 'For each'
    case 'parallel':
      return 'Parallel'
    case 'condition':
      return 'If / else'
    case 'switch':
      return 'Switch'
    case 'transform':
      return 'Set fields'
    case 'filter':
      return 'Filter'
    case 'stop':
      return 'Stop'
    case 'data':
      switch (node.data.op) {
        case 'compose':
          return 'Compose'
        case 'parseJson':
          return 'Parse JSON'
        case 'join':
          return 'Join'
        case 'csvTable':
          return 'Create CSV table'
        case 'htmlTable':
          return 'Create HTML table'
        case 'filterArray':
          return 'Filter array'
        case 'select':
          return 'Select'
      }
      break
    case 'humanReview':
      return 'Request information'
    case 'input':
      return 'Input'
    case 'output':
      return 'Output'
    case 'subflow':
      return 'Subflow'
    case 'router':
      return 'AI router'
    case 'errorShield':
      return 'Error shield'
    case 'variable':
      switch (node.data.op) {
        case 'initialize':
          return 'Initialize variable'
        case 'set':
          return 'Set variable'
        case 'increment':
          return 'Increment variable'
        case 'decrement':
          return 'Decrement variable'
        case 'appendArray':
          return 'Append to array variable'
        case 'appendString':
          return 'Append to string variable'
      }
  }
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items))
}

function add(
  issues: FlowValidationIssue[],
  level: FlowValidationIssue['level'],
  code: string,
  message: string,
  nodeId?: string,
) {
  issues.push({ level, code, message, ...(nodeId ? { nodeId } : {}) })
}

function hasTemplate(value: string | undefined): boolean {
  return Boolean(value?.includes('{{'))
}

function validateHttpUrl(issues: FlowValidationIssue[], value: string, nodeId: string) {
  if (!value.trim()) {
    add(issues, 'error', 'MISSING_HTTP_URL', 'HTTP request needs a URL.', nodeId)
    return
  }
  if (hasTemplate(value)) return
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') {
      add(issues, 'error', 'INVALID_HTTP_URL', 'HTTP request URL must start with https://.', nodeId)
    }
  } catch {
    add(issues, 'error', 'INVALID_HTTP_URL', 'HTTP request URL is not valid.', nodeId)
  }
}

function validateJsonObjectField(issues: FlowValidationIssue[], value: string | undefined, message: string, nodeId: string) {
  if (!value?.trim() || hasTemplate(value)) return
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) add(issues, 'error', 'INVALID_JSON_OBJECT', message, nodeId)
  } catch {
    add(issues, 'error', 'INVALID_JSON_OBJECT', message, nodeId)
  }
}

function validateTemplatedJsonField(issues: FlowValidationIssue[], value: string | undefined, message: string, nodeId: string) {
  if (!value?.trim() || hasTemplate(value)) return
  try {
    JSON.parse(value)
  } catch {
    add(issues, 'error', 'INVALID_JSON', message, nodeId)
  }
}

function parseObjectJson(value: string | undefined): Record<string, unknown> | null {
  if (!value?.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function validateTriggerConfig(issues: FlowValidationIssue[], trigger: unknown) {
  if (trigger === undefined) return
  if (!isRecord(trigger)) {
    add(issues, 'error', 'INVALID_TRIGGER_CONFIG', 'The Trigger configuration is invalid.', 'trigger')
    return
  }
  const type = trigger.type
  if (type !== undefined && (typeof type !== 'string' || !(FLOW_TRIGGER_TYPES as readonly string[]).includes(type))) {
    add(issues, 'error', 'INVALID_TRIGGER_TYPE', 'The Trigger type is not supported.', 'trigger')
    return
  }
  if (trigger.inputFields !== undefined) {
    if (!Array.isArray(trigger.inputFields)) {
      add(issues, 'error', 'INVALID_INPUT_FIELDS', 'Trigger input fields are invalid.', 'trigger')
    } else {
      const names = trigger.inputFields
        .filter(isRecord)
        .map((field) => (typeof field.name === 'string' ? field.name.trim() : ''))
      names.forEach((name, index) => {
        if (!name) add(issues, 'error', 'MISSING_INPUT_FIELD_NAME', `Trigger input field ${index + 1} needs a name.`, 'trigger')
      })
      for (const name of unique(names.filter(Boolean))) {
        if (names.filter((entry) => entry === name).length > 1) {
          add(issues, 'error', 'DUPLICATE_INPUT_FIELD', `Trigger has duplicate input field "${name}".`, 'trigger')
        }
      }
      trigger.inputFields.filter(isRecord).forEach((field, index) => {
        if (field.type !== undefined && (typeof field.type !== 'string' || !(FIELD_TYPES as readonly string[]).includes(field.type))) {
          add(issues, 'error', 'INVALID_INPUT_FIELD_TYPE', `Trigger input field ${index + 1} has an invalid type.`, 'trigger')
        }
      })
    }
  }
  if (type === 'slack') {
    const events = Array.isArray(trigger.events) ? trigger.events : []
    if (events.length === 0) {
      add(issues, 'error', 'MISSING_SLACK_EVENTS', 'A Slack trigger needs at least one event kind (mention, DM, channel message, or slash command).', 'trigger')
    }
    for (const kind of events) {
      if (typeof kind !== 'string' || !(SLACK_EVENT_KINDS as readonly string[]).includes(kind)) {
        add(issues, 'error', 'INVALID_SLACK_EVENT', `Slack trigger has an unknown event kind "${String(kind)}".`, 'trigger')
      }
    }
    if (events.includes('slash_command') && !String(trigger.command ?? '').trim()) {
      add(issues, 'error', 'MISSING_SLACK_COMMAND', 'A slash-command Slack trigger needs the command (e.g. /deploy).', 'trigger')
    }
    if (trigger.threadMemory === true && !(Array.isArray(trigger.channels) && trigger.channels.length > 0)) {
      add(
        issues,
        'warning',
        'THREAD_MEMORY_UNSCOPED',
        'Conversation memory is on but this trigger is not restricted to specific channels — if another unrestricted threadMemory flow also matches an event, only the first flow to reply keeps the thread.',
        'trigger',
      )
    }
    return
  }
  if (type !== 'schedule') return
  const schedule = trigger.schedule
  if (!isRecord(schedule)) {
    add(issues, 'error', 'MISSING_SCHEDULE', 'Scheduled triggers need a schedule.', 'trigger')
    return
  }
  const scheduleType = typeof schedule.type === 'string' ? schedule.type : 'daily'
  if (['daily', 'weekly', 'once'].includes(scheduleType) && !String(schedule.time ?? '').trim()) {
    add(issues, 'error', 'MISSING_SCHEDULE_TIME', 'Scheduled triggers need a run time.', 'trigger')
  }
  if (scheduleType === 'once' && !String(schedule.runAt ?? '').trim()) {
    add(issues, 'error', 'MISSING_SCHEDULE_DATE', 'One-time scheduled triggers need a date.', 'trigger')
  }
  if (scheduleType === 'cron' && !String(schedule.cron ?? '').trim()) {
    add(issues, 'error', 'MISSING_CRON', 'Cron scheduled triggers need a cron expression.', 'trigger')
  }
}

function requiredToolArgs(inputSchema: unknown): string[] {
  if (!isRecord(inputSchema)) return []
  if (inputSchema.type !== undefined && inputSchema.type !== 'object') return []
  return Array.isArray(inputSchema.required) ? inputSchema.required.filter((item): item is string => typeof item === 'string') : []
}

function argHasValue(value: unknown): boolean {
  return value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '')
}

function conditionClauses(node: Extract<FlowNode, { type: 'condition' | 'filter' }>) {
  if (node.data.clauses?.length) return node.data.clauses
  if (node.type === 'condition' && (node.data.left !== undefined || node.data.right !== undefined)) {
    return [{ left: node.data.left ?? '', op: node.data.op ?? 'contains', right: node.data.right ?? '' }]
  }
  return []
}

function isAgentStructured(agent: Extract<FlowNode, { type: 'agent' }> | undefined): boolean {
  if (!agent) return false
  if (agent.data.responseFormat === 'structured') {
    const hasNonBlankField = agent.data.outputFields?.some((field) => typeof field.name === 'string' && field.name.trim())
    return hasNonBlankField ?? false
  }
  return false
}

/** Nodes reachable from `startId` via edges + container membership (inclusive). */
function reachableFrom(graph: FlowGraph, startId: string): Set<string> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const seen = new Set<string>()
  const visit = (id: string) => {
    if (seen.has(id)) return
    const node = byId.get(id)
    if (!node) return
    seen.add(id)
    if (node.type === 'loop') node.data.body.forEach(visit)
    if (node.type === 'repeatUntil') node.data.body.forEach(visit)
    if (node.type === 'parallel') node.data.branches.flat().forEach(visit)
    if (node.type === 'errorShield') {
      node.data.body.forEach(visit)
      node.data.fallback.forEach(visit)
    }
    graph.edges.filter((edge) => edge.source === id).forEach((edge) => visit(edge.target))
  }
  visit(startId)
  return seen
}

function reachableNodeIds(graph: FlowGraph): Set<string> {
  return reachableFrom(graph, 'trigger')
}

/**
 * Variable step checks. "Initialized earlier" is validated cheaply: the graph
 * has no full topological order helper, so a mutation is flagged when NO
 * initialize of its name exists, or when every initialize sits strictly
 * downstream of it (reachable from the mutation — definitely later). An
 * initialize in a sibling branch can't be ordered cheaply and is allowed;
 * the interpreter fails those cleanly at runtime ("hasn't been initialized").
 */
function validateVariableNodes(graph: FlowGraph, issues: FlowValidationIssue[]) {
  const variableNodes = graph.nodes.filter((node): node is Extract<FlowNode, { type: 'variable' }> => node.type === 'variable')
  if (!variableNodes.length) return
  const initializers = variableNodes.filter((node) => node.data.op === 'initialize')
  const initNames = initializers.map((node) => node.data.name.trim()).filter(Boolean)
  for (const name of unique(initNames)) {
    if (initNames.filter((entry) => entry === name).length > 1) {
      const dupes = initializers.filter((node) => node.data.name.trim() === name)
      for (const dupe of dupes.slice(1)) {
        add(issues, 'error', 'DUPLICATE_VARIABLE', `Two steps initialize the variable "${name}" — give each its own name.`, dupe.id)
      }
    }
  }
  for (const node of variableNodes) {
    const name = node.data.name.trim()
    if (!name) {
      add(issues, 'error', 'MISSING_VARIABLE_NAME', `${nodeLabel(node)} needs a variable name.`, node.id)
      continue
    }
    if (['set', 'appendArray', 'appendString'].includes(node.data.op) && !node.data.value?.trim()) {
      add(issues, 'error', 'MISSING_VARIABLE_VALUE', `${nodeLabel(node)} needs a value.`, node.id)
    }
    if (node.data.op === 'initialize') continue
    const declarations = initializers.filter((init) => init.data.name.trim() === name)
    const downstream = reachableFrom(graph, node.id)
    // Not downstream of the mutation = earlier on its path, or in a sibling
    // branch we can't cheaply order (allowed; the interpreter fails cleanly).
    const earlier = declarations.filter((init) => !downstream.has(init.id))
    if (!earlier.length) {
      add(issues, 'error', 'UNINITIALIZED_VARIABLE', `${nodeLabel(node)} needs the variable "${name}" to be initialized earlier in the flow.`, node.id)
      continue
    }
    if (node.data.op === 'increment' || node.data.op === 'decrement') {
      const numeric = earlier.some((init) => ['integer', 'float'].includes(init.data.varType ?? 'string'))
      if (!numeric) {
        add(issues, 'error', 'VARIABLE_NOT_NUMERIC', `${nodeLabel(node)} needs "${name}" to be a number variable.`, node.id)
      }
    }
  }
}

export function validateFlowGraph(graph: FlowGraph, context: FlowValidationContext = {}): FlowValidationResult {
  const issues: FlowValidationIssue[] = []
  const agentIds = new Set((context.agents ?? []).map((agent) => agent.id))
  const connectionIds = new Set((context.toolCatalog ?? []).map((connection) => connection.id))
  const toolNamesByConnection = new Map((context.toolCatalog ?? []).map((connection) => [
    connection.id,
    new Set((connection.tools ?? []).map((tool) => tool.name)),
  ]))
  const toolsByConnection = new Map((context.toolCatalog ?? []).map((connection) => [
    connection.id,
    new Map((connection.tools ?? []).map((tool) => [tool.name, tool])),
  ]))
  const byId = new Map<string, FlowNode>()
  const triggerIds = graph.nodes.filter((node) => node.type === 'trigger').map((node) => node.id)

  for (const node of graph.nodes) {
    if (byId.has(node.id)) add(issues, 'error', 'DUPLICATE_NODE_ID', `Multiple steps use the id "${node.id}".`, node.id)
    byId.set(node.id, node)
  }

  if (triggerIds.length !== 1 || triggerIds[0] !== 'trigger') {
    add(issues, 'error', 'INVALID_TRIGGER', 'The flow needs exactly one Trigger step with id "trigger".')
  }
  const triggerNode = graph.nodes.find((node): node is Extract<FlowNode, { type: 'trigger' }> => node.type === 'trigger')
  validateTriggerConfig(issues, triggerNode?.data.trigger)

  const actionable = graph.nodes.filter((node) => node.type !== 'trigger')
  if (context.requireRunnable !== false && actionable.length === 0) {
    add(issues, 'error', 'NO_STEPS', 'Add at least one step before running or publishing this flow.')
  }

  for (const edge of graph.edges) {
    if (!byId.has(edge.source)) add(issues, 'error', 'DANGLING_EDGE', `An edge starts from missing step "${edge.source}".`)
    if (!byId.has(edge.target)) add(issues, 'error', 'DANGLING_EDGE', `An edge points to missing step "${edge.target}".`)
  }

  for (const node of graph.nodes) {
    if (node.type === 'agent') {
      const hasAgent = Boolean(node.data.agentId?.trim())
      const hasPrompt = Boolean(node.data.prompt?.trim())
      if (!hasAgent && !hasPrompt) {
        add(issues, 'error', 'MISSING_AGENT_OR_PROMPT', `${nodeLabel(node)} needs a saved agent or an inline prompt.`, node.id)
      } else if (hasAgent && context.agents && !agentIds.has(node.data.agentId)) {
        add(issues, 'error', 'UNKNOWN_AGENT', `${nodeLabel(node)} uses an agent that is not available.`, node.id)
      } else if (hasAgent && hasPrompt) {
        add(issues, 'warning', 'AGENT_AND_PROMPT', `${nodeLabel(node)} has both a saved agent and an inline prompt — the saved agent is used and the prompt is ignored.`, node.id)
      }
      if (!hasAgent && hasPrompt) { /* inline: input optional */ }
      else if (!node.data.input?.trim()) {
        add(issues, 'warning', 'EMPTY_AGENT_INPUT', `${nodeLabel(node)} has an empty message.`, node.id)
      }
    }

    if (node.type === 'tool') {
      if (!node.data.connectionId) {
        add(issues, 'error', 'MISSING_TOOL_CONNECTION', `${nodeLabel(node)} needs a connection.`, node.id)
      } else if (context.toolCatalog && !connectionIds.has(node.data.connectionId)) {
        add(issues, 'error', 'UNKNOWN_TOOL_CONNECTION', `${nodeLabel(node)} uses a connection that is not available.`, node.id)
      }
      if (!node.data.toolName) {
        add(issues, 'error', 'MISSING_TOOL', `${nodeLabel(node)} needs a tool.`, node.id)
      } else if (context.toolCatalog && toolNamesByConnection.get(node.data.connectionId)?.size) {
        const knownTools = toolNamesByConnection.get(node.data.connectionId)
        if (knownTools && !knownTools.has(node.data.toolName)) {
          add(issues, 'error', 'UNKNOWN_TOOL', `${nodeLabel(node)} uses a tool that is not available on the selected connection.`, node.id)
        }
      }
      validateJsonObjectField(issues, node.data.args, `${nodeLabel(node)} arguments must be a JSON object.`, node.id)
      const selectedTool = toolsByConnection.get(node.data.connectionId)?.get(node.data.toolName)
      if (node.data.actionSchemaHash && selectedTool?.schemaHash && node.data.actionSchemaHash !== selectedTool.schemaHash) {
        add(issues, 'error', 'TOOL_SCHEMA_CHANGED', `${nodeLabel(node)} changed in the connected integration. Re-select the action and review its arguments before publishing.`, node.id)
      }
      if (node.data.risk && selectedTool?.risk && node.data.risk !== selectedTool.risk) {
        add(issues, 'error', 'TOOL_RISK_CHANGED', `${nodeLabel(node)} has a new safety classification. Re-select the action before publishing.`, node.id)
      }
      const requiredArgs = requiredToolArgs(selectedTool?.inputSchema)
      if (requiredArgs.length) {
        const parsedArgs = parseObjectJson(node.data.args)
        if (parsedArgs) {
          for (const argName of requiredArgs) {
            if (!argHasValue(parsedArgs[argName])) {
              add(issues, 'error', 'MISSING_TOOL_ARG', `${nodeLabel(node)} needs "${argName}".`, node.id)
            }
          }
        }
      }
    }

    if (node.type === 'tool' || node.type === 'http') {
      // Credential health, surfaced where the flow is checked rather than only
      // in the connection editor. A FAILED connection blocks publish; one that
      // has merely never been proven warns — a first run is how it gets proven.
      const usedId = node.data.connectionId
      const entry = usedId ? context.toolCatalog?.find((candidate) => candidate.id === usedId) : undefined
      if (entry?.verification?.state === 'failed') {
        add(issues, 'error', 'CONNECTION_FAILED', `${nodeLabel(node)} uses a connection that is not working${entry.verification.error ? ` — ${entry.verification.error}` : ''}. Reconnect it in Integrations.`, node.id)
      } else if (entry && (entry.verification?.state === 'unverified' || entry.verification?.state === 'stale')) {
        add(issues, 'warning', 'CONNECTION_UNVERIFIED', `${nodeLabel(node)} uses a connection that has not been confirmed working yet — test the step, or test the connection in Integrations.`, node.id)
      }
    }

    if (node.type === 'code' && !node.data.code.trim()) {
      add(issues, 'error', 'MISSING_CODE', `${nodeLabel(node)} has no code to run.`, node.id)
    }

    if (node.type === 'http') {
      validateHttpUrl(issues, node.data.url, node.id)
      if (node.data.connectionId && context.toolCatalog && !connectionIds.has(node.data.connectionId)) {
        add(issues, 'warning', 'UNKNOWN_HTTP_CONNECTION', `${nodeLabel(node)} authenticates with a connection that is not available — pick another connection or reconnect it in Integrations.`, node.id)
      }
      validateJsonObjectField(issues, node.data.headers, `${nodeLabel(node)} headers must be a JSON object.`, node.id)
      validateJsonObjectField(issues, node.data.query, `${nodeLabel(node)} query params must be a JSON object.`, node.id)
      if ((node.data.bodyMode ?? 'json') === 'json') {
        validateTemplatedJsonField(issues, node.data.body, `${nodeLabel(node)} body must be valid JSON or a data value.`, node.id)
      }
      // DELETE (and OPTIONS) legitimately carry bodies now; only GET/HEAD
      // cannot, and the executor fails those loudly when Send Body is on —
      // this warning is the design-time twin of that runtime error.
      if ((node.data.bodyMode ?? 'json') !== 'none' && ['GET', 'HEAD'].includes(node.data.method) && node.data.sendBody === true && node.data.body?.trim()) {
        add(issues, 'warning', 'HTTP_BODY_IGNORED', `${nodeLabel(node)} cannot send a body for ${node.data.method} — switch the method or turn Send Body off.`, node.id)
      }
      // Inline auth holding a LITERAL secret keeps that secret in the graph,
      // which fans out to publishedGraph, version snapshots, run snapshots,
      // exports, copilot grounding, and the clipboard — each an independent
      // place it can escape. A warning rather than an error: existing flows must
      // keep running while their owner moves the secret to the vault.
      const inlineSecrets = literalAuthSecrets(node.data.auth)
      if (inlineSecrets.length > 0) {
        add(
          issues,
          'warning',
          'INLINE_AUTH_SECRET',
          `${nodeLabel(node)} stores its ${inlineSecrets.join(' and ')} directly in this flow. Save it as a credential (Integrations → Credentials) and attach it instead, so the secret stays out of the flow's definition, history, and exports.`,
          node.id,
        )
      }
      if (node.data.authMode === 'generic' && !node.data.credentialId?.trim()) {
        add(issues, 'error', 'MISSING_CREDENTIAL', `${nodeLabel(node)} is set to use a saved credential but none is chosen.`, node.id)
      }
    }

    if (node.type === 'loop') {
      if (!node.data.over.trim()) add(issues, 'error', 'MISSING_LOOP_SOURCE', `${nodeLabel(node)} needs a list to process.`, node.id)
      if (node.data.body.length === 0) add(issues, 'error', 'EMPTY_LOOP_BODY', `${nodeLabel(node)} needs at least one nested step.`, node.id)
      for (const bodyId of node.data.body) {
        if (!byId.has(bodyId)) add(issues, 'error', 'MISSING_CONTAINER_STEP', `${nodeLabel(node)} references missing nested step "${bodyId}".`, node.id)
      }
      if (node.data.threadAgent) {
        if ((node.data.concurrency ?? 1) > 1) {
          add(issues, 'warning', 'THREAD_FORCES_SEQUENTIAL', `${nodeLabel(node)} threads one conversation across iterations, so it runs sequentially (concurrency 1).`, node.id)
        }
        const bodyHasAgent = node.data.body.some((id) => byId.get(id)?.type === 'agent')
        if (!bodyHasAgent) {
          add(issues, 'warning', 'THREAD_NO_AGENT', `${nodeLabel(node)} has conversation threading on but no agent step in its body.`, node.id)
        }
      }
    }

    if (node.type === 'parallel') {
      if (node.data.branches.length === 0) add(issues, 'error', 'EMPTY_PARALLEL', `${nodeLabel(node)} needs at least one branch.`, node.id)
      node.data.branches.forEach((branch, index) => {
        if (branch.length === 0) add(issues, 'error', 'EMPTY_PARALLEL_BRANCH', `${nodeLabel(node)} branch ${index + 1} is empty.`, node.id)
        for (const branchNodeId of branch) {
          if (!byId.has(branchNodeId)) add(issues, 'error', 'MISSING_CONTAINER_STEP', `${nodeLabel(node)} references missing branch step "${branchNodeId}".`, node.id)
        }
      })
      if (node.data.join === 'object' && node.data.labels && node.data.labels.length !== node.data.branches.length) {
        add(issues, 'warning', 'JOIN_LABELS_MISMATCH', `${nodeLabel(node)} has ${node.data.labels.length} join label(s) for ${node.data.branches.length} branch(es).`, node.id)
      }
    }

    if (node.type === 'repeatUntil') {
      if (node.data.body.length === 0) add(issues, 'error', 'EMPTY_REPEAT_BODY', `${nodeLabel(node)} needs at least one nested step.`, node.id)
      if (node.data.clauses.length === 0) add(issues, 'error', 'EMPTY_REPEAT_CONDITION', `${nodeLabel(node)} needs a stop condition.`, node.id)
      for (const bodyId of node.data.body) if (!byId.has(bodyId)) add(issues, 'error', 'MISSING_CONTAINER_STEP', `${nodeLabel(node)} references missing nested step "${bodyId}".`, node.id)
    }

    if (node.type === 'condition' || node.type === 'filter') {
      const clauses = conditionClauses(node)
      if (clauses.length === 0) add(issues, 'error', 'EMPTY_CONDITION', `${nodeLabel(node)} needs at least one condition.`, node.id)
      clauses.forEach((clause, index) => {
        if (!clause.left.trim()) add(issues, 'error', 'MISSING_CONDITION_LEFT', `${nodeLabel(node)} condition ${index + 1} needs data to check.`, node.id)
      })
    }

    if (node.type === 'switch') {
      if (node.data.cases.length === 0) add(issues, 'error', 'EMPTY_SWITCH', `${nodeLabel(node)} needs at least one case.`, node.id)
      const caseIds = node.data.cases.map((entry) => entry.id).filter(Boolean)
      for (const caseId of unique(caseIds)) {
        if (caseIds.filter((entry) => entry === caseId).length > 1) {
          add(issues, 'error', 'DUPLICATE_SWITCH_CASE', `${nodeLabel(node)} has duplicate case id "${caseId}".`, node.id)
        }
      }
      node.data.cases.forEach((entry, index) => {
        if (!entry.id.trim()) add(issues, 'error', 'MISSING_SWITCH_CASE_ID', `${nodeLabel(node)} case ${index + 1} needs an id.`, node.id)
        if (!entry.left.trim()) add(issues, 'error', 'MISSING_SWITCH_LEFT', `${nodeLabel(node)} case ${index + 1} needs data to check.`, node.id)
      })
      if (!graph.edges.some((edge) => edge.source === node.id && edge.branch === 'default')) {
        add(issues, 'warning', 'MISSING_SWITCH_DEFAULT', `${nodeLabel(node)} has no default branch.`, node.id)
      }
    }

    if (node.type === 'router') {
      if (node.data.branches.length === 0) add(issues, 'error', 'EMPTY_ROUTER', `${nodeLabel(node)} needs at least one branch.`, node.id)
      const ids = node.data.branches.map((b) => b.id.trim()).filter(Boolean)
      node.data.branches.forEach((b, index) => {
        if (!b.id.trim()) add(issues, 'error', 'MISSING_ROUTER_BRANCH_ID', `${nodeLabel(node)} branch ${index + 1} needs an id.`, node.id)
        if (!b.description?.trim() && !b.label?.trim()) add(issues, 'warning', 'ROUTER_BRANCH_NO_HINT', `${nodeLabel(node)} branch ${index + 1} has no label or description for the AI to route on.`, node.id)
      })
      for (const id of unique(ids)) {
        if (ids.filter((entry) => entry === id).length > 1) add(issues, 'error', 'DUPLICATE_ROUTER_BRANCH', `${nodeLabel(node)} has duplicate branch id "${id}".`, node.id)
      }
      if (!graph.edges.some((edge) => edge.source === node.id && edge.branch === 'default')) {
        add(issues, 'warning', 'MISSING_ROUTER_DEFAULT', `${nodeLabel(node)} has no default branch.`, node.id)
      }
    }
    if (node.type === 'errorShield') {
      if (node.data.body.length === 0) add(issues, 'error', 'EMPTY_SHIELD_BODY', `${nodeLabel(node)} needs at least one step in its body.`, node.id)
      if (node.data.fallback.length === 0) add(issues, 'warning', 'EMPTY_SHIELD_FALLBACK', `${nodeLabel(node)} has no fallback steps — a body error is swallowed and produces no output.`, node.id)
      for (const memberId of [...node.data.body, ...node.data.fallback]) {
        if (!byId.has(memberId)) add(issues, 'error', 'MISSING_CONTAINER_STEP', `${nodeLabel(node)} references missing step "${memberId}".`, node.id)
      }
    }

    if (node.type === 'transform') {
      if (node.data.fields.length === 0) add(issues, 'error', 'EMPTY_TRANSFORM', `${nodeLabel(node)} needs at least one field.`, node.id)
      const names = node.data.fields.map((field) => field.name.trim()).filter(Boolean)
      node.data.fields.forEach((field, index) => {
        if (!field.name.trim()) add(issues, 'error', 'MISSING_TRANSFORM_FIELD', `${nodeLabel(node)} field ${index + 1} needs a name.`, node.id)
      })
      for (const name of unique(names)) {
        if (names.filter((entry) => entry === name).length > 1) {
          add(issues, 'error', 'DUPLICATE_TRANSFORM_FIELD', `${nodeLabel(node)} has duplicate field "${name}".`, node.id)
        }
      }
    }
    if (node.type === 'humanReview') {
      if (!node.data.message.trim()) {
        add(issues, 'error', 'MISSING_REVIEW_MESSAGE', `${nodeLabel(node)} needs a message for the reviewer.`, node.id)
      }
    }

    if (node.type === 'input') {
      const names = node.data.params.map((p) => p.name.trim())
      names.forEach((name, index) => {
        if (!name) add(issues, 'error', 'MISSING_INPUT_PARAM_NAME', `${nodeLabel(node)} param ${index + 1} needs a name.`, node.id)
      })
      for (const name of unique(names.filter(Boolean))) {
        if (names.filter((entry) => entry === name).length > 1) {
          add(issues, 'error', 'DUPLICATE_INPUT_PARAM', `${nodeLabel(node)} has duplicate param "${name}".`, node.id)
        }
      }
    }
    if (node.type === 'output') {
      const names = node.data.fields.map((f) => f.name.trim())
      node.data.fields.forEach((field, index) => {
        if (!field.name.trim()) add(issues, 'error', 'MISSING_OUTPUT_FIELD_NAME', `${nodeLabel(node)} field ${index + 1} needs a name.`, node.id)
      })
      for (const name of unique(names.filter(Boolean))) {
        if (names.filter((entry) => entry === name).length > 1) {
          add(issues, 'error', 'DUPLICATE_OUTPUT_FIELD', `${nodeLabel(node)} has duplicate field "${name}".`, node.id)
        }
      }
    }
    if (node.type === 'subflow') {
      if (!node.data.flowId.trim()) add(issues, 'error', 'MISSING_SUBFLOW_FLOW', `${nodeLabel(node)} needs a flow to run.`, node.id)
      validateJsonObjectField(issues, node.data.input, `${nodeLabel(node)} input must map to a JSON object.`, node.id)
    }

    if (node.type === 'data') {
      if (!node.data.input?.trim()) {
        add(issues, 'error', 'MISSING_DATA_INPUT', `${nodeLabel(node)} needs data to work with.`, node.id)
      }
      // separator (join) is optional — it defaults to ',' at run time.
      if (node.data.op === 'filterArray') {
        const clauses = node.data.clauses ?? []
        if (clauses.length === 0) add(issues, 'error', 'EMPTY_DATA_CLAUSES', `${nodeLabel(node)} needs at least one condition.`, node.id)
        clauses.forEach((clause, index) => {
          if (!clause.left.trim()) add(issues, 'error', 'MISSING_DATA_CLAUSE_LEFT', `${nodeLabel(node)} condition ${index + 1} needs data to check.`, node.id)
        })
      }
      if (node.data.op === 'select') {
        const fields = node.data.fields ?? []
        if (fields.length === 0) add(issues, 'error', 'EMPTY_DATA_FIELDS', `${nodeLabel(node)} needs at least one field.`, node.id)
        fields.forEach((field, index) => {
          if (!field.name.trim()) add(issues, 'error', 'MISSING_DATA_FIELD_NAME', `${nodeLabel(node)} field ${index + 1} needs a name.`, node.id)
        })
      }
    }
  }

  validateVariableNodes(graph, issues)

  const inputNodes = graph.nodes.filter((node) => node.type === 'input')
  for (const dup of inputNodes.slice(1)) {
    add(issues, 'error', 'MULTIPLE_INPUT_NODES', 'A flow can have only one Input step.', dup.id)
  }
  const outputNodes = graph.nodes.filter((node) => node.type === 'output')
  for (const dup of outputNodes.slice(1)) {
    add(issues, 'error', 'MULTIPLE_OUTPUT_NODES', 'A flow can have only one Output step.', dup.id)
  }

  const containerMemberIds = new Set(
    graph.nodes.flatMap((node) =>
      node.type === 'loop' ? node.data.body
      : node.type === 'repeatUntil' ? node.data.body
      : node.type === 'parallel' ? node.data.branches.flat()
      : node.type === 'errorShield' ? [...node.data.body, ...node.data.fallback]
      : [],
    ),
  )
  for (const memberId of containerMemberIds) {
    const member = byId.get(memberId)
    if (!member) continue
    // Input/Output declare the flow's callable signature and belong at the top
    // level only. `subflow` is INTENTIONALLY allowed inside a container — a
    // subflow-per-item is the supported nested-iteration pattern (spec §3.3).
    if (member.type === 'input' || member.type === 'output') {
      add(issues, 'error', 'IO_NODE_IN_CONTAINER', `${nodeLabel(member)} can't run inside a For each / Parallel body. Use a subflow-per-item instead.`, member.id)
    }
    // Warning (not an error): the run still works, but resuming a paused
    // container replays its body, so the same question is asked again.
    if (member.type === 'humanReview') {
      add(
        issues,
        'warning',
        'HUMAN_REVIEW_IN_CONTAINER',
        `${nodeLabel(member)} inside a loop or parallel branches will re-ask on resume — move it to the main flow for now.`,
        member.id,
      )
    }
  }

  const flaggedNodeIds = new Set<string>()
  for (const node of graph.nodes) {
    if (node.type === 'agent' || node.type === 'trigger') continue
    const dataStr = JSON.stringify(node.data)
    const fieldRefRegex = /\{\{\s*step\.([^.}\s]+)\.output\.([^}\s]+)\s*\}\}/g
    let match
    while ((match = fieldRefRegex.exec(dataStr)) !== null) {
      const agentId = match[1]
      const fieldName = match[2]
      if (fieldName === 'output') continue
      const agentNode = byId.get(agentId)
      if (agentNode?.type === 'agent' && !isAgentStructured(agentNode as Extract<FlowNode, { type: 'agent' }>)) {
        if (!flaggedNodeIds.has(node.id)) {
          add(issues, 'warning', 'TEXT_AGENT_FIELD_REF', `${nodeLabel(node)} maps a field from ${nodeLabel(agentNode)}, but that agent returns plain text — switch its response to Structured.`, node.id)
          flaggedNodeIds.add(node.id)
        }
        break
      }
    }
  }

  const reachable = reachableNodeIds(graph)
  for (const node of graph.nodes) {
    if (node.type !== 'trigger' && !reachable.has(node.id)) {
      add(issues, 'warning', 'UNREACHABLE_STEP', `${nodeLabel(node)} is not connected to the trigger.`, node.id)
    }
  }

  // The engine follows a PLAIN (unlabelled) edge from a branch node only as a
  // fallback — when the chosen output has no labeled wire of its own. Once
  // every possible output is wired, a plain edge can never light and its
  // subtree silently never runs.
  for (const node of graph.nodes) {
    const possibleLabels =
      node.type === 'condition' ? ['true', 'false']
      : node.type === 'switch' ? [...node.data.cases.map((entry) => entry.id), 'default']
      : node.type === 'router' ? [...node.data.branches.map((entry) => entry.id), 'default']
      : null
    if (!possibleLabels) continue
    const outgoing = graph.edges.filter((edge) => edge.source === node.id)
    const hasPlain = outgoing.some((edge) => !edge.branch)
    if (!hasPlain) continue
    const everyOutputWired = possibleLabels.every((label) => outgoing.some((edge) => edge.branch === label))
    if (everyOutputWired) {
      add(
        issues,
        'warning',
        'UNREACHABLE_PLAIN_EDGE',
        `${nodeLabel(node)} has an unlabelled connection that can never run — every output already has its own wire. Reconnect it to a specific output.`,
        node.id,
      )
    }
  }

  const errors = issues.filter((issue) => issue.level === 'error')
  const warnings = issues.filter((issue) => issue.level === 'warning')
  return { ok: errors.length === 0, errors, warnings, issues }
}

export function validationErrorMessage(result: FlowValidationResult): string {
  if (result.ok) return ''
  const first = result.errors[0]
  const extra = result.errors.length > 1 ? ` (+${result.errors.length - 1} more)` : ''
  return `${first.message}${extra}`
}
