/**
 * n8n workflow import — the inverse of `toN8nWorkflow` (src/lib/export/n8n.ts),
 * grounded in n8n's own source (see docs/superpowers/specs/
 * 2026-08-05-n8n-import-parity-design.md for the file:line evidence).
 *
 * The centerpiece is the AI-agent CLUSTER: in n8n an agent's model, tools and
 * memory are separate nodes wired via non-`main` connection types
 * (`ai_languageModel`, `ai_tool`, `ai_memory`, …) keyed by the SUB-NODE's name
 * pointing into the agent. This converter absorbs the whole cluster into one
 * materialized Sublime agent (agentsToCreate — the same machinery the portable
 * import uses): `options.systemMessage` → instructions, the attached chat model
 * → the agent's model (claude-* values run natively), `<node>Tool`-suffixed
 * integration sub-nodes → integration slugs the runtime binds to live
 * connectors.
 *
 * The long tail of n8n integration nodes still imports as HTTP request STUBS —
 * label kept, original type + parameters preserved in the step's note — and
 * every stub is reported via `stubbedNodes` so nothing disappears silently.
 * n8n `={{ … }}` expressions are kept verbatim with a summary warning.
 */
import { z } from 'zod'
import {
  flowGraphSchema,
  type ConditionClause,
  type ConditionOp,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
} from '@/lib/flows/graph'
import type { FlowTrigger } from '@/lib/flows/trigger'
import type { PortableAgent } from '@/lib/export/portable'
import { FlowImportError, type ImportedFlow, type StubbedNode } from './types'

const n8nNodeSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  type: z.string(),
  parameters: z.record(z.string(), z.unknown()).default({}),
  position: z.tuple([z.number(), z.number()]).optional(),
  disabled: z.boolean().optional(),
  notes: z.string().optional(),
  onError: z.string().optional(),
  retryOnFail: z.boolean().optional(),
  maxTries: z.number().optional(),
  waitBetweenTries: z.number().optional(),
  credentials: z.record(z.string(), z.unknown()).optional(),
}).passthrough()

const n8nWorkflowSchema = z.object({
  name: z.string().optional(),
  nodes: z.array(n8nNodeSchema),
  connections: z.record(z.string(), z.unknown()).default({}),
}).passthrough()

type N8nNode = z.infer<typeof n8nNodeSchema>

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
const WAIT_UNITS = ['seconds', 'minutes', 'hours', 'days'] as const

/** n8n filter operations with a direct ConditionOp equivalent. */
const OP_MAP: Record<string, ConditionOp> = {
  equals: 'eq', notEquals: 'neq',
  larger: 'gt', largerEqual: 'gte', smaller: 'lt', smallerEqual: 'lte',
  gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte',
  after: 'gt', before: 'lt', afterOrEquals: 'gte', beforeOrEquals: 'lte',
  contains: 'contains', regex: 'matches',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

const asString = (value: unknown): string =>
  value === undefined || value === null ? '' : typeof value === 'string' ? value : String(value)

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\:]/g, '\\$&')

const pad2 = (value: number) => String(value).padStart(2, '0')

function baseType(type: string): string {
  return type.split('.').pop() ?? type
}

function isLangchain(type: string): boolean {
  return type.includes('n8n-nodes-langchain')
}

function isTriggerType(type: string): boolean {
  const base = baseType(type)
  return /trigger$/i.test(base) || base === 'webhook' || base === 'cron'
}

/**
 * n8n's newer model params serialize as a resourceLocator object
 * ({ __rl: true, mode, value }) that collapses to `.value`
 * (n8n node-helpers.ts:330); older versions are plain strings, and Gemini
 * names its param `modelName` instead of `model`.
 */
function modelValueOf(node: N8nNode): string {
  const p = node.parameters
  if (isRecord(p.model) && p.model.__rl) return asString(p.model.value)
  if (typeof p.model === 'string') return p.model
  return asString(p.modelName)
}

/** n8n filter operator → our clause op/right; null when it can't translate. */
function mapOperator(operator: Record<string, unknown>, rightValue: string): { op: ConditionOp; right: string } | null {
  const operation = asString(operator.operation)
  const direct = OP_MAP[operation]
  if (direct) return { op: direct, right: rightValue }
  switch (operation) {
    case 'startsWith': return { op: 'matches', right: `^${escapeRegex(rightValue)}` }
    case 'endsWith': return { op: 'matches', right: `${escapeRegex(rightValue)}$` }
    case 'true': return { op: 'eq', right: 'true' }
    case 'false': return { op: 'eq', right: 'false' }
    case 'empty': case 'notExists': return { op: 'eq', right: '' }
    case 'notEmpty': case 'exists': return { op: 'neq', right: '' }
    default: return null
  }
}

/** n8n if/filter/switch-rule conditions → our clauses. Untranslatable → flagged. */
function clausesFrom(parameters: Record<string, unknown>): { match: 'all' | 'any'; clauses: ConditionClause[]; complete: boolean } {
  const conditions = isRecord(parameters.conditions) ? parameters.conditions : undefined
  const list = conditions && Array.isArray(conditions.conditions) ? conditions.conditions : []
  const match = conditions?.combinator === 'or' ? 'any' : 'all'
  const clauses: ConditionClause[] = []
  let complete = list.length > 0
  for (const entry of list) {
    if (!isRecord(entry) || !isRecord(entry.operator)) { complete = false; continue }
    const mapped = mapOperator(entry.operator, asString(entry.rightValue))
    if (!mapped) { complete = false; continue }
    clauses.push({ left: asString(entry.leftValue), op: mapped.op, right: mapped.right })
  }
  return { match, clauses, complete }
}

/** { parameters: [{name, value}] } (n8n keypair editors) → JSON object string. */
function pairsToJson(raw: unknown): string | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.parameters)) return undefined
  const out: Record<string, string> = {}
  for (const pair of raw.parameters) {
    if (isRecord(pair) && pair.name) out[asString(pair.name)] = asString(pair.value)
  }
  return Object.keys(out).length ? JSON.stringify(out) : undefined
}

/** googleSheets → google_sheets */
const camelToSnake = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

/** n8n scheduleTrigger rule → a runnable Sublime schedule trigger. */
function scheduleTriggerFrom(node: N8nNode, warnings: string[]): FlowTrigger {
  const rule = isRecord(node.parameters.rule) ? node.parameters.rule : {}
  const interval = Array.isArray(rule.interval) && isRecord(rule.interval[0]) ? rule.interval[0] : {}
  const field = asString(interval.field) || 'days'
  const minute = Number(interval.triggerAtMinute) || 0
  const hour = Number(interval.triggerAtHour) || 0
  const schedule = (() => {
    switch (field) {
      case 'cronExpression': {
        // n8n cron is `([Second]) Minute Hour DoM Month DoW` — drop the
        // optional seconds field for a standard 5-field expression.
        const parts = asString(interval.expression).trim().split(/\s+/)
        return { type: 'cron', cron: (parts.length === 6 ? parts.slice(1) : parts).join(' ') }
      }
      case 'seconds':
        warnings.push('The n8n schedule ran every few seconds — imported as every minute (the shortest Sublime cadence).')
        return { type: 'cron', cron: '* * * * *' }
      case 'minutes':
        return { type: 'cron', cron: `*/${Math.max(1, Number(interval.minutesInterval) || 1)} * * * *` }
      case 'hours':
        return { type: 'cron', cron: `${minute} */${Math.max(1, Number(interval.hoursInterval) || 1)} * * *` }
      case 'weeks':
        return { type: 'weekly', time: `${pad2(hour)}:${pad2(minute)}` }
      case 'months':
        return { type: 'cron', cron: `${minute} ${hour} ${Math.max(1, Number(interval.triggerAtDayOfMonth) || 1)} * *` }
      default: {
        const every = Math.max(1, Number(interval.daysInterval) || 1)
        if (every === 1) return { type: 'daily', time: `${pad2(hour)}:${pad2(minute)}` }
        warnings.push(`The n8n schedule ran every ${every} days — imported as a cron schedule.`)
        return { type: 'cron', cron: `${minute} ${hour} */${every} * *` }
      }
    }
  })()
  return { type: 'schedule', schedule }
}

function triggerFor(node: N8nNode, warnings: string[]): FlowTrigger {
  const base = baseType(node.type)
  if (base === 'webhook') return { type: 'webhook' }
  if (base === 'scheduleTrigger' || base === 'cron') return scheduleTriggerFrom(node, warnings)
  return { type: 'manual' }
}

/** The ai_* sub-nodes attached to one agent/chain node. */
type AiAttachments = { models: N8nNode[]; tools: N8nNode[]; memory: N8nNode[] }

/**
 * Absorb an agent cluster into a materialized-agent spec + the agent step.
 * `<node>Tool`-suffixed integration sub-nodes become integration slugs; the
 * dedicated langchain tools each get a precise warning instead of silence.
 */
function agentFromCluster(
  node: N8nNode,
  id: string,
  attach: AiAttachments,
  warnings: string[],
): { spec: PortableAgent; step: FlowNode } {
  const p = node.parameters
  const options = isRecord(p.options) ? p.options : {}
  const base = baseType(node.type)

  let instructions = asString(options.systemMessage)
  if (base === 'chainLlm') {
    const messages = isRecord(p.messages) && Array.isArray(p.messages.messageValues) ? p.messages.messageValues : []
    const system = messages
      .filter((entry): entry is Record<string, unknown> => isRecord(entry) && entry.type === 'system')
      .map((entry) => asString(entry.message))
      .filter(Boolean)
    if (system.length) instructions = [instructions, ...system].filter(Boolean).join('\n\n')
  }
  if (!instructions) instructions = asString(p.toolDescription) || `Imported from the n8n workflow step "${node.name}".`

  let model: string | undefined
  const modelNode = attach.models[0]
  if (modelNode) {
    const requested = modelValueOf(modelNode)
    if (requested.startsWith('claude-')) model = requested
    else if (requested) warnings.push(`"${node.name}" used the model "${requested}", which is not available here — the workspace default model is used instead.`)
  }
  if (attach.models.length > 1) {
    warnings.push(`"${node.name}" had a fallback model — Sublime handles model fallback automatically, so it was not imported.`)
  }

  const integrations: string[] = []
  for (const tool of attach.tools) {
    const toolBase = baseType(tool.type)
    if (toolBase === 'mcpClientTool') {
      const endpoint = asString(tool.parameters.endpointUrl) || asString(tool.parameters.sseEndpoint)
      warnings.push(`"${node.name}" used an MCP server tool ("${tool.name}"${endpoint ? ` at ${endpoint}` : ''}) — connect that MCP server in Settings → Integrations, then add it to the agent.`)
      continue
    }
    if (toolBase === 'httpRequestTool' || toolBase === 'toolHttpRequest') {
      warnings.push(`"${node.name}" used a custom HTTP tool ("${tool.name}") — rebuild it as an HTTP step or an MCP tool the agent can call.`)
      continue
    }
    if (toolBase === 'toolCode') {
      warnings.push(`"${node.name}" used a custom code tool ("${tool.name}") — that logic needs a Code step or a tool the agent can call.`)
      continue
    }
    if (toolBase === 'toolWorkflow') {
      warnings.push(`"${node.name}" called another workflow as a tool ("${tool.name}") — import that workflow and use a Subflow step instead.`)
      continue
    }
    if (toolBase === 'agentTool') {
      warnings.push(`"${node.name}" delegated to a sub-agent ("${tool.name}") — re-create that agent and reference it from this one.`)
      continue
    }
    if (isLangchain(tool.type)) {
      warnings.push(`"${node.name}" used the built-in n8n tool "${tool.name}" (${toolBase}) — Sublime agents cover most built-ins natively; review whether it is still needed.`)
      continue
    }
    if (toolBase.endsWith('Tool')) {
      integrations.push(camelToSnake(toolBase.slice(0, -'Tool'.length)))
      continue
    }
    warnings.push(`"${node.name}" used a tool ("${tool.name}", ${tool.type}) that has no direct equivalent — reconnect it manually.`)
  }
  if (attach.memory.length) {
    warnings.push(`"${node.name}" had an attached memory (${attach.memory.map((memory) => memory.name).join(', ')}) — Sublime agents manage their own memory, so it was not imported.`)
  }

  // n8n's `promptType: 'auto'` default feeds `$json.chatInput`; Sublime agents
  // already see upstream context via includeUpstream, so that collapses to ''.
  const rawText = asString(p.text)
  const input = !rawText || rawText === '={{ $json.chatInput }}' ? '' : rawText

  const spec: PortableAgent = {
    ref: id,
    title: node.name,
    instructions,
    goal: null,
    ...(model ? { model } : {}),
    integrations: Array.from(new Set(integrations)),
  }
  const step: FlowNode = { id, type: 'agent', data: { agentId: id, label: node.name, input } }
  return { spec, step }
}

/**
 * n8n's pure-data nodes (Limit, Sort, Split Out, …) import as GENERATED
 * JavaScript code steps — deterministic and actually runnable, not stubs.
 * The code-node guest exposes `items` (the previous step's list) and the
 * returned value becomes the step output (lib/code/run-js.ts). Every
 * parameter from the untrusted workflow file is embedded via JSON.stringify —
 * values are data, never code.
 */
const GET_PATH_JS = "const get = (obj, path) => String(path).split('.').reduce((o, k) => (o == null ? o : o[k]), obj);"

function dataNodeCode(base: string, p: Record<string, unknown>, warnings: string[], label: string): string | null {
  switch (base) {
    case 'limit': {
      const max = Math.max(1, Number(p.maxItems) || 1)
      return p.keep === 'lastItems' ? `return items.slice(-${max});` : `return items.slice(0, ${max});`
    }
    case 'sort': {
      const type = asString(p.type) || 'simple'
      if (type === 'random') return 'return [...items].sort(() => Math.random() - 0.5);'
      if (type !== 'simple') {
        warnings.push(`"${label}" sorted with custom code — that comparator does not translate; re-enter it in the Code step.`)
        return null
      }
      const raw = isRecord(p.sortFieldsUi) && Array.isArray(p.sortFieldsUi.sortField) ? p.sortFieldsUi.sortField : []
      const fields = raw.flatMap((entry) => isRecord(entry) && entry.fieldName
        ? [{ name: asString(entry.fieldName), dir: entry.order === 'descending' ? -1 : 1 }] : [])
      if (!fields.length) return 'return items;'
      return [
        `const fields = ${JSON.stringify(fields)};`,
        GET_PATH_JS,
        'return [...items].sort((a, b) => {',
        '  for (const f of fields) {',
        '    const av = get(a, f.name), bv = get(b, f.name);',
        '    if (av === bv) continue;',
        '    if (av == null) return -f.dir;',
        '    if (bv == null) return f.dir;',
        '    return (av < bv ? -1 : 1) * f.dir;',
        '  }',
        '  return 0;',
        '});',
      ].join('\n')
    }
    case 'splitOut': {
      const fields = asString(p.fieldToSplitOut).split(',').map((field) => field.trim()).filter(Boolean)
      if (!fields.length) return null
      const includeOther = p.include === 'allOtherFields'
      const dest = asString(p.destinationFieldName) || null
      return [
        `const fields = ${JSON.stringify(fields)};`,
        `const includeOther = ${JSON.stringify(includeOther)};`,
        `const dest = ${JSON.stringify(dest)};`,
        'const out = [];',
        'for (const item of items) {',
        "  const obj = item && typeof item === 'object' ? item : {};",
        '  const max = Math.max(1, ...fields.map((f) => (Array.isArray(obj[f]) ? obj[f].length : 1)));',
        '  for (let i = 0; i < max; i += 1) {',
        '    const row = includeOther ? { ...obj } : {};',
        '    for (const f of fields) {',
        '      const value = obj[f];',
        '      row[dest ?? f] = Array.isArray(value) ? value[i] : value;',
        '    }',
        '    out.push(row);',
        '  }',
        '}',
        'return out;',
      ].join('\n')
    }
    case 'aggregate': {
      const dest = asString(p.destinationFieldName) || 'data'
      if (p.aggregate !== 'aggregateIndividualFields') {
        return `return { [${JSON.stringify(dest)}]: items };`
      }
      const raw = isRecord(p.fieldsToAggregate) && Array.isArray(p.fieldsToAggregate.fieldToAggregate) ? p.fieldsToAggregate.fieldToAggregate : []
      const fields = raw.flatMap((entry) => isRecord(entry) && entry.fieldToAggregate
        ? [{ field: asString(entry.fieldToAggregate), out: asString(entry.outputFieldName) || asString(entry.fieldToAggregate) }] : [])
      if (!fields.length) return `return { [${JSON.stringify(dest)}]: items };`
      return [
        `const fields = ${JSON.stringify(fields)};`,
        GET_PATH_JS,
        'const result = {};',
        'for (const f of fields) result[f.out] = items.map((item) => get(item, f.field));',
        'return result;',
      ].join('\n')
    }
    case 'removeDuplicates': {
      const operation = asString(p.operation) || 'removeDuplicateInputItems'
      if (operation !== 'removeDuplicateInputItems') {
        warnings.push(`"${label}" deduplicated against previous executions — that history does not travel; the step now dedupes within one run.`)
      }
      const compare = asString(p.compare) || 'allFields'
      const fields = asString(p.fieldsToCompare ?? p.fieldsToExclude).split(',').map((field) => field.trim()).filter(Boolean)
      return [
        `const mode = ${JSON.stringify(compare)};`,
        `const fields = ${JSON.stringify(fields)};`,
        GET_PATH_JS,
        'const seen = new Set();',
        'const out = [];',
        'for (const item of items) {',
        "  const obj = item && typeof item === 'object' ? item : {};",
        '  let key;',
        "  if (mode === 'allFieldsExcept') { const clone = { ...obj }; for (const f of fields) delete clone[f]; key = JSON.stringify(clone); }",
        "  else if (mode === 'selectedFields' && fields.length) key = JSON.stringify(fields.map((f) => get(obj, f)));",
        '  else key = JSON.stringify(obj);',
        '  if (seen.has(key)) continue;',
        '  seen.add(key);',
        '  out.push(item);',
        '}',
        'return out;',
      ].join('\n')
    }
    case 'renameKeys': {
      const raw = isRecord(p.keys) && Array.isArray(p.keys.key) ? p.keys.key : []
      const renames = raw.flatMap((entry) => isRecord(entry) && entry.currentKey
        ? [{ from: asString(entry.currentKey), to: asString(entry.newKey) }] : [])
      if (isRecord(p.additionalOptions) && p.additionalOptions.regexReplacement) {
        warnings.push(`"${label}" renamed keys by regex — only the exact-key renames were imported.`)
      }
      return [
        `const renames = ${JSON.stringify(renames)};`,
        'return items.map((item) => {',
        "  if (!item || typeof item !== 'object') return item;",
        '  const obj = { ...item };',
        '  for (const r of renames) { if (r.from in obj) { obj[r.to] = obj[r.from]; delete obj[r.from]; } }',
        '  return obj;',
        '});',
      ].join('\n')
    }
    default:
      return null
  }
}

const DATA_CODE_NODES = new Set(['limit', 'sort', 'splitOut', 'aggregate', 'removeDuplicates', 'renameKeys'])

type Mapped =
  | { kind: 'node'; node: FlowNode; stub?: true }
  | { kind: 'drop' } // merge/noOp/stickyNote — rewire straight through

function mapNode(node: N8nNode, id: string, warnings: string[]): Mapped {
  const p = node.parameters
  const base = baseType(node.type)
  const label = node.name

  if (base === 'stickyNote' || base === 'merge' || base === 'noOp' || base === 'executionData') {
    if (base === 'merge' && p.mode && p.mode !== 'append') {
      warnings.push(`"${label}" merged branches by "${asString(p.mode)}" — branches were wired straight through; re-shape the data with a Data step if needed.`)
    }
    return { kind: 'drop' }
  }

  if (base === 'openAi' && isLangchain(node.type)) {
    warnings.push(`"${label}" was an n8n AI step — bind it to one of your agents or refine its inline prompt.`)
    return {
      kind: 'node',
      node: { id, type: 'agent', data: { agentId: '', label, prompt: asString(p.text ?? p.prompt), input: '' } },
    }
  }

  switch (base) {
    case 'httpRequest': {
      const method = HTTP_METHODS.includes(asString(p.method).toUpperCase() as typeof HTTP_METHODS[number])
        ? (asString(p.method).toUpperCase() as typeof HTTP_METHODS[number]) : 'GET'
      const headers = pairsToJson(p.headerParameters)
      const query = pairsToJson(p.queryParameters)
      let body = asString(p.jsonBody ?? p.body)
      let bodyMode: 'json' | 'raw' | 'formUrlencoded' | undefined
      const keypairBody = pairsToJson(p.bodyParameters)
      if (keypairBody) {
        body = keypairBody
        bodyMode = p.contentType === 'form-urlencoded' ? 'formUrlencoded' : 'json'
      } else if (p.contentType === 'raw' && body) {
        bodyMode = 'raw'
      }
      if (p.authentication && p.authentication !== 'none') {
        warnings.push(`"${label}" used n8n credentials — re-enter authentication for this HTTP step.`)
      }
      const options = isRecord(p.options) ? p.options : {}
      const redirect = isRecord(options.redirect) && isRecord(options.redirect.redirect) ? options.redirect.redirect : undefined
      const batching = isRecord(options.batching) && isRecord(options.batching.batch) ? options.batching.batch : undefined
      const timeout = Number(options.timeout)
      return {
        kind: 'node',
        node: {
          id, type: 'http',
          data: {
            label, method, url: asString(p.url),
            ...(headers ? { headers, sendHeaders: true } : {}),
            ...(query ? { query, sendQuery: true } : {}),
            ...(body ? { body, sendBody: true } : {}),
            ...(bodyMode ? { bodyMode } : {}),
            ...(p.contentType === 'raw' && p.rawContentType ? { bodyContentType: asString(p.rawContentType) } : {}),
            ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: Math.min(120000, Math.max(1000, timeout)) } : {}),
            ...(redirect ? {
              followRedirects: redirect.followRedirects !== false,
              ...(Number.isFinite(Number(redirect.maxRedirects)) ? { maxRedirects: Math.min(10, Math.max(0, Number(redirect.maxRedirects))) } : {}),
            } : {}),
            ...(batching && Number(batching.batchSize) > 0 ? {
              batch: {
                size: Math.min(1000, Math.max(1, Number(batching.batchSize))),
                ...(Number(batching.batchInterval) > 0 ? { delayMs: Math.min(60000, Number(batching.batchInterval)) } : {}),
              },
            } : {}),
          },
        },
      }
    }
    case 'if': {
      const { match, clauses, complete } = clausesFrom(p)
      if (!complete) warnings.push(`"${label}": some conditions did not translate — re-enter them.`)
      return { kind: 'node', node: { id, type: 'condition', data: { label, match, clauses } } }
    }
    case 'filter': {
      const { match, clauses, complete } = clausesFrom(p)
      if (!complete) warnings.push(`"${label}": some conditions did not translate — re-enter them.`)
      return { kind: 'node', node: { id, type: 'filter', data: { label, match, clauses } } }
    }
    case 'switch': {
      const rules = isRecord(p.rules) && Array.isArray(p.rules.values) ? p.rules.values : []
      const cases = rules.map((rule, index) => {
        const conditions = isRecord(rule)
          ? clausesFrom(rule)
          : { clauses: [] as ConditionClause[], complete: false, match: 'all' as const }
        const first = conditions.clauses[0]
        if (!first) warnings.push(`"${label}" case ${index + 1}: the rule did not translate — re-enter it.`)
        return {
          id: `case-${index}`,
          label: isRecord(rule) ? asString(rule.outputKey) || undefined : undefined,
          left: first?.left ?? '', op: first?.op ?? ('eq' as ConditionOp), right: first?.right ?? '',
        }
      })
      return { kind: 'node', node: { id, type: 'switch', data: { label, cases } } }
    }
    case 'code': case 'function': case 'functionItem':
      return {
        kind: 'node',
        node: {
          id, type: 'code',
          data: {
            label,
            language: asString(p.language).startsWith('python') || asString(p.language) === 'python' ? 'python' : 'javascript',
            mode: asString(p.mode) === 'runOnceForEachItem' ? 'eachItem' : 'allItems',
            code: asString(p.jsCode ?? p.pythonCode ?? p.functionCode),
          },
        },
      }
    case 'set': {
      if (p.mode === 'raw') {
        return { kind: 'node', node: { id, type: 'data', data: { label, op: 'parseJson', input: asString(p.jsonOutput) } } }
      }
      const fields: Array<{ name: string; value: string }> = []
      const assignments = isRecord(p.assignments) && Array.isArray(p.assignments.assignments) ? p.assignments.assignments : []
      for (const entry of assignments) {
        if (isRecord(entry) && entry.name) fields.push({ name: asString(entry.name), value: asString(entry.value) })
      }
      // Legacy shape (< typeVersion 3.3): values.{string,number,boolean}[].
      if (!fields.length && isRecord(p.values)) {
        for (const bucket of Object.values(p.values)) {
          if (!Array.isArray(bucket)) continue
          for (const entry of bucket) {
            if (isRecord(entry) && entry.name) fields.push({ name: asString(entry.name), value: asString(entry.value) })
          }
        }
      }
      return { kind: 'node', node: { id, type: 'transform', data: { label, fields } } }
    }
    case 'wait': {
      if (p.resume && p.resume !== 'timeInterval') {
        warnings.push(`"${label}" waited for a ${asString(p.resume)} — imported as a plain delay; re-model the resume trigger.`)
      }
      const unit = WAIT_UNITS.includes(asString(p.unit) as typeof WAIT_UNITS[number])
        ? (asString(p.unit) as typeof WAIT_UNITS[number]) : 'seconds'
      const amount = Number(p.amount)
      return { kind: 'node', node: { id, type: 'wait', data: { label, amount: Number.isFinite(amount) && amount >= 0 ? amount : 5, unit } } }
    }
    case 'splitInBatches':
      // Loop wiring is resolved by absorbLoopBodies after the edges exist;
      // the warning fires there only when the cycle cannot be absorbed.
      return { kind: 'node', node: { id, type: 'loop', data: { label, over: '', body: [] } } }
    case 'stopAndError':
      return {
        kind: 'node',
        node: {
          id, type: 'stop',
          data: { label, reason: asString(p.errorMessage) || (p.errorObject !== undefined ? asString(p.errorObject) : '') },
        },
      }
    case 'respondToWebhook': {
      const options = isRecord(p.options) ? p.options : {}
      const code = Number(options.responseCode ?? p.responseCode)
      const respondWith = asString(p.respondWith) || 'json'
      let bodyMode: 'json' | 'text' | 'none' = 'json'
      let body: string | undefined
      if (respondWith === 'text') { bodyMode = 'text'; body = asString(p.responseBody) }
      else if (respondWith === 'json') {
        bodyMode = 'json'
        body = typeof p.responseBody === 'string' ? p.responseBody : p.responseBody === undefined ? undefined : JSON.stringify(p.responseBody)
      } else if (respondWith === 'noData') bodyMode = 'none'
      else if (respondWith === 'firstIncomingItem' || respondWith === 'allIncomingItems') bodyMode = 'json'
      else {
        bodyMode = 'none'
        warnings.push(`"${label}" responded with ${respondWith} — that response type is not supported; the webhook returns an empty response.`)
      }
      return {
        kind: 'node',
        node: {
          id, type: 'respondWebhook',
          data: {
            label,
            statusCode: Number.isInteger(code) && code >= 100 && code <= 599 ? code : 200,
            ...(body !== undefined ? { body } : {}),
            bodyMode,
          },
        },
      }
    }
    case 'executeWorkflow':
      warnings.push(`"${label}" ran another n8n workflow — import that workflow too, then select it in this step.`)
      return { kind: 'node', node: { id, type: 'subflow', data: { label, flowId: '' } } }
    default: {
      if (DATA_CODE_NODES.has(base)) {
        const code = dataNodeCode(base, p, warnings, label)
        if (code !== null) {
          return { kind: 'node', node: { id, type: 'code', data: { label, language: 'javascript', mode: 'allItems', code } } }
        }
      }
      // The integration tail: import as an honest HTTP stub. The original
      // type + parameters travel in the note so the API call can be rebuilt.
      const note = `Imported from n8n node "${node.type}". Rebuild this step as the equivalent API request.\nOriginal parameters:\n${JSON.stringify(p, null, 2)}`.slice(0, 4000)
      return {
        kind: 'node', stub: true,
        node: { id, type: 'http', data: { label, note, method: 'GET', url: '' } },
      }
    }
  }
}

/** Node types that accept each imported node-level property. */
const SUPPORTS_ONERROR = new Set(['agent', 'tool', 'http', 'code', 'subflow'])
const SUPPORTS_RETRIES = new Set(['agent', 'tool', 'http', 'code'])
const SUPPORTS_DISABLED = new Set(['agent', 'tool', 'http', 'code'])
const SUPPORTS_NOTE = new Set([
  'agent', 'condition', 'stop', 'tool', 'http', 'code', 'transform', 'filter', 'switch', 'variable', 'data',
  'humanReview', 'respondWebhook', 'wait', 'repeatUntil', 'input', 'output', 'subflow', 'router', 'errorShield', 'loop', 'parallel',
])

/** Copy n8n node-level properties onto the mapped step where the schema allows. */
function applyCommonProps(mapped: FlowNode, source: N8nNode, warnings: string[]): void {
  const data = mapped.data as Record<string, unknown>
  if (source.notes && SUPPORTS_NOTE.has(mapped.type) && data.note === undefined) data.note = source.notes
  if (source.disabled && SUPPORTS_DISABLED.has(mapped.type)) data.disabled = true
  if (source.onError && source.onError !== 'stopWorkflow' && SUPPORTS_ONERROR.has(mapped.type)) {
    data.onError = 'continue'
    if (source.onError === 'continueErrorOutput') {
      warnings.push(`"${source.name}" routed errors to a separate branch — imported as continue-on-error; add an Error Shield if the error path had its own steps.`)
    }
  }
  if (source.retryOnFail && SUPPORTS_RETRIES.has(mapped.type)) {
    data.retries = Math.min(5, Math.max(0, Number(source.maxTries) || 3))
    if (mapped.type === 'http' && Number(source.waitBetweenTries) > 0) {
      data.retryDelayMs = Math.min(60000, Number(source.waitBetweenTries))
    }
  }
}

const AI_ATTACHMENT_TYPES = new Set(['ai_languageModel', 'ai_tool', 'ai_memory', 'ai_outputParser', 'ai_embedding', 'ai_vectorStore', 'ai_retriever', 'ai_reranker', 'ai_textSplitter', 'ai_document'])
const AGENT_FAMILY = new Set(['agent', 'agentTool', 'chainLlm'])

export function fromN8nWorkflow(raw: unknown): ImportedFlow {
  const parsed = n8nWorkflowSchema.safeParse(raw)
  if (!parsed.success) throw new FlowImportError('This n8n workflow file is missing its nodes.', 'INVALID_GRAPH')
  const workflow = parsed.data
  const warnings: string[] = []
  const stubbedNodes: StubbedNode[] = []
  const agentsToCreate: PortableAgent[] = []

  const byName = new Map(workflow.nodes.map((node) => [node.name, node]))

  // --- AI cluster index: sub-node → agent attachments, keyed by TARGET name.
  // In n8n's JSON the SUB-NODE is the source key (its ai_* connection points
  // INTO the agent), so this loop walks connections from the sub-node side.
  const attachmentsByTarget = new Map<string, AiAttachments>()
  const absorbed = new Set<string>()
  for (const [sourceName, value] of Object.entries(workflow.connections)) {
    if (!isRecord(value)) continue
    const source = byName.get(sourceName)
    if (!source) continue
    for (const [connType, bundles] of Object.entries(value)) {
      if (!AI_ATTACHMENT_TYPES.has(connType) || !Array.isArray(bundles)) continue
      for (const bundle of bundles) {
        if (!Array.isArray(bundle)) continue
        for (const link of bundle) {
          if (!isRecord(link) || typeof link.node !== 'string') continue
          const attach = attachmentsByTarget.get(link.node) ?? { models: [], tools: [], memory: [] }
          if (connType === 'ai_languageModel') attach.models.push(source)
          else if (connType === 'ai_tool') attach.tools.push(source)
          else if (connType === 'ai_memory') attach.memory.push(source)
          // Parsers/embeddings/etc. are absorbed silently — nothing to map.
          attachmentsByTarget.set(link.node, attach)
          absorbed.add(sourceName)
        }
      }
    }
  }

  // ids: prefer n8n's node id; names resolve connections. Trigger becomes 'trigger'.
  const idByName = new Map<string, string>()
  const usedIds = new Set<string>(['trigger'])
  const triggerNodes = workflow.nodes.filter((node) => isTriggerType(node.type) && !absorbed.has(node.name))
  const primaryTrigger: N8nNode | undefined = triggerNodes[0]
  if (triggerNodes.length > 1) {
    warnings.push('The n8n workflow had multiple triggers — they were merged into one.')
  }

  const nodes: FlowNode[] = []
  const dropped = new Set<string>()
  const layout: NonNullable<FlowGraph['layout']> = {}

  for (const node of workflow.nodes) {
    if (absorbed.has(node.name)) continue

    let id: string
    if (node === primaryTrigger) {
      id = 'trigger'
    } else {
      const preferred = node.id && !usedIds.has(node.id)
        ? node.id
        : node.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'step'
      let candidate = preferred
      for (let n = 2; usedIds.has(candidate); n += 1) candidate = `${preferred}-${n}`
      id = candidate
      usedIds.add(id)
    }
    idByName.set(node.name, id)
    if (node.position) layout[id] = { x: Math.round(node.position[0]), y: Math.round(node.position[1]) }

    if (node === primaryTrigger) {
      nodes.push({ id: 'trigger', type: 'trigger', data: { trigger: triggerFor(node, warnings) } })
      continue
    }
    if (isTriggerType(node.type)) {
      // Extra triggers merge into the single 'trigger' via drop-and-rewire.
      dropped.add(id)
      continue
    }

    if (isLangchain(node.type) && AGENT_FAMILY.has(baseType(node.type))) {
      const attach = attachmentsByTarget.get(node.name) ?? { models: [], tools: [], memory: [] }
      const { spec, step } = agentFromCluster(node, id, attach, warnings)
      applyCommonProps(step, node, warnings)
      agentsToCreate.push(spec)
      nodes.push(step)
      continue
    }

    const mapped = mapNode(node, id, warnings)
    if (mapped.kind === 'drop') { dropped.add(id); continue }
    applyCommonProps(mapped.node, node, warnings)
    nodes.push(mapped.node)
    if (mapped.stub) stubbedNodes.push({ nodeId: id, label: node.name, originalType: node.type })
  }

  // connections: { "<source name>": { main: [ [ {node,type,index} ] ] } }
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const edges: FlowEdge[] = []
  // splitInBatches output 1 is the LOOP branch (n8n outputNames ['done','loop']);
  // those edges are held aside for absorbLoopBodies instead of wired directly.
  const loopStarts: Array<{ loopId: string; target: string }> = []
  let edgeSeq = 1
  for (const [sourceName, value] of Object.entries(workflow.connections)) {
    const sourceId = idByName.get(sourceName)
    if (!sourceId) continue
    const main = isRecord(value) && Array.isArray(value.main) ? value.main : []
    main.forEach((bundle, outputIndex) => {
      if (!Array.isArray(bundle)) return
      for (const link of bundle) {
        if (!isRecord(link) || typeof link.node !== 'string') continue
        const targetId = idByName.get(link.node)
        if (!targetId) continue
        const source = nodeById.get(sourceId)
        if (source?.type === 'loop' && outputIndex === 1) {
          loopStarts.push({ loopId: sourceId, target: targetId })
          continue
        }
        const branch =
          source?.type === 'condition' ? (outputIndex === 0 ? 'true' : 'false')
          : source?.type === 'switch' ? source.data.cases[outputIndex]?.id ?? 'default'
          : undefined
        edges.push({ id: `e-${edgeSeq++}`, source: sourceId, target: targetId, ...(branch ? { branch } : {}) })
      }
    })
  }

  // Drop-and-rewire merge/noOp/extra-trigger nodes. A dropped node with no
  // incoming edges (an extra trigger) rewires from 'trigger'.
  let liveEdges = edges
  for (const dropId of dropped) {
    const incoming = liveEdges.filter((edge) => edge.target === dropId)
    const outgoing = liveEdges.filter((edge) => edge.source === dropId)
    const sources = incoming.length ? incoming : [{ id: '', source: 'trigger', target: dropId } as FlowEdge]
    const bridged: FlowEdge[] = []
    for (const into of sources) {
      for (const out of outgoing) {
        bridged.push({ id: `e-${edgeSeq++}`, source: into.source, target: out.target, ...(into.branch ? { branch: into.branch } : {}) })
      }
    }
    liveEdges = liveEdges.filter((edge) => edge.source !== dropId && edge.target !== dropId).concat(bridged)
    delete layout[dropId]
  }

  // Loop surgery: absorb each splitInBatches cycle into the loop node's body.
  // Walk the held-aside loop branch; a single chain that returns to the loop
  // node becomes data.body (ids), its chain edges removed. Anything tangled
  // falls back to a plain edge + warning.
  for (const { loopId, target } of loopStarts) {
    const loop = nodeById.get(loopId)
    if (!loop || loop.type !== 'loop') continue
    const body: string[] = []
    const chainEdges: FlowEdge[] = []
    let current: string | undefined = target
    let absorbed = false
    const visited = new Set<string>()
    while (current && !visited.has(current) && body.length <= 100) {
      visited.add(current)
      body.push(current)
      const outgoing = liveEdges.filter((edge) => edge.source === current)
      if (outgoing.length !== 1) break
      chainEdges.push(outgoing[0])
      if (outgoing[0].target === loopId) { absorbed = true; break }
      current = outgoing[0].target
    }
    if (absorbed && body.every((id) => nodeById.has(id))) {
      loop.data.body = body
      const predecessors = Array.from(new Set(liveEdges.filter((edge) => edge.target === loopId && !chainEdges.includes(edge)).map((edge) => edge.source)))
      loop.data.over = predecessors.length === 1
        ? (predecessors[0] === 'trigger' ? '{{trigger.input}}' : `{{step.${predecessors[0]}.output}}`)
        : ''
      const remove = new Set(chainEdges)
      liveEdges = liveEdges.filter((edge) => !remove.has(edge) && !body.includes(edge.target as string))
    } else {
      liveEdges.push({ id: `e-${edgeSeq++}`, source: loopId, target })
      warnings.push(`"${(loop.data as { label?: string }).label ?? loopId}": n8n loop wiring does not translate cleanly — move the looped steps into the Loop step and set what it loops over.`)
    }
  }

  // formTrigger: surface its typed fields as a first-class input node wired
  // directly behind the trigger, so the imported flow keeps its signature.
  if (primaryTrigger && (baseType(primaryTrigger.type) === 'formTrigger' || baseType(primaryTrigger.type) === 'form')) {
    const formFields = isRecord(primaryTrigger.parameters.formFields) && Array.isArray(primaryTrigger.parameters.formFields.values)
      ? primaryTrigger.parameters.formFields.values : []
    const params = formFields.flatMap((field) => {
      if (!isRecord(field) || !field.fieldLabel) return []
      const name = asString(field.fieldLabel).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
      if (!name) return []
      const type = field.fieldType === 'number' ? 'number' : field.fieldType === 'checkbox' ? 'boolean' : 'string'
      return [{ name, type: type as 'string' | 'number' | 'boolean', ...(field.requiredField === true ? { required: true } : {}) }]
    })
    if (params.length) {
      let inputId = 'form-input'
      for (let n = 2; usedIds.has(inputId); n += 1) inputId = `form-input-${n}`
      usedIds.add(inputId)
      const inputNode: FlowNode = {
        id: inputId, type: 'input',
        data: { label: asString(primaryTrigger.parameters.formTitle) || 'Form input', params },
      }
      const triggerIndex = nodes.findIndex((node) => node.id === 'trigger')
      nodes.splice(triggerIndex + 1, 0, inputNode)
      nodeById.set(inputId, inputNode)
      for (const edge of liveEdges) {
        if (edge.source === 'trigger') edge.source = inputId
      }
      liveEdges.push({ id: `e-${edgeSeq++}`, source: 'trigger', target: inputId })
    }
  }

  // No trigger in the workflow: prepend a manual one wired to the entry nodes.
  const trigger: FlowTrigger = primaryTrigger ? triggerFor(primaryTrigger, []) : { type: 'manual' }
  if (!primaryTrigger) {
    nodes.unshift({ id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } })
    const hasIncoming = new Set(liveEdges.map((edge) => edge.target))
    for (const node of nodes) {
      if (node.id === 'trigger' || hasIncoming.has(node.id)) continue
      liveEdges.push({ id: `e-${edgeSeq++}`, source: 'trigger', target: node.id })
    }
  }

  // Dedupe identical bridged edges (drop-and-rewire can double up on diamonds).
  const seenEdges = new Set<string>()
  const finalEdges = liveEdges.filter((edge) => {
    const key = `${edge.source}→${edge.target}→${edge.branch ?? ''}`
    if (seenEdges.has(key)) return false
    seenEdges.add(key)
    return true
  })

  const liveN8nNodes = workflow.nodes.filter((node) => !absorbed.has(node.name))
  const expressionHits = JSON.stringify(liveN8nNodes).match(/=\{\{|\$json|\$node\b/g)
  if (expressionHits?.length) {
    warnings.push(`${expressionHits.length} n8n expression reference(s) were kept as-is — rewrite them as {{step.…}} or {{input.…}} references.`)
  }

  const graphParse = flowGraphSchema.safeParse({ nodes, edges: finalEdges, ...(Object.keys(layout).length ? { layout } : {}) })
  if (!graphParse.success) {
    const issue = graphParse.error.issues[0]
    throw new FlowImportError(`Converted n8n workflow failed validation: ${issue.path.join('.')} — ${issue.message}`, 'INVALID_GRAPH')
  }

  return {
    name: workflow.name || 'Imported n8n workflow',
    description: '',
    trigger,
    graph: graphParse.data,
    agentsToCreate,
    source: 'n8n',
    warnings: Array.from(new Set(warnings)),
    stubbedNodes,
  }
}
