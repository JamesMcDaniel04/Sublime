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
import { agentHttpToolSchema, MAX_AGENT_HTTP_TOOLS, type AgentHttpTool } from '@/lib/agents/http-tools'
import { FlowImportError, type CredentialGroup, type ImportedFlow, type StubbedNode } from './types'
import { lookupN8nCredential } from './n8n-credential-map'

/**
 * n8n OAuth credential types whose token our runtime can supply from an
 * existing Nango connection — these import as predefined-connection auth
 * (runnable immediately when the workspace has the integration connected)
 * instead of a vault credential the user cannot mint for user-grant OAuth.
 */
const NANGO_CREDENTIAL_MAP: Record<string, string> = {
  salesforceoauth2api: 'nango:salesforce',
  gmailoauth2: 'nango:gmail',
  googlesheetsoauth2api: 'nango:sheets',
  googledriveoauth2api: 'nango:drive',
  googledocsoauth2api: 'nango:drive',
  googlecalendaroauth2api: 'nango:calendar',
  slackoauth2api: 'nango:slack',
  githuboauth2api: 'nango:github',
  asanaoauth2api: 'nango:asana',
}

/** Name-sniffing fallback for credential types newer than the generated table. */
function vaultTypeFor(sourceType: string): NonNullable<CredentialGroup['credentialType']> {
  const lower = sourceType.toLowerCase()
  if (lower.includes('oauth2')) return 'oauth2'
  if (lower.includes('basicauth') || lower.includes('basic_auth')) return 'basic'
  if (lower.includes('headerauth') || lower.includes('header_auth') || lower.includes('apikey')) return 'apiKeyHeader'
  return 'bearer'
}

type VaultCredentialInfo = Pick<
  CredentialGroup,
  'credentialType' | 'suggestedHeaderName' | 'suggestedQueryParam' | 'suggestedEntries' | 'sourceDisplayName' | 'unsupported'
>

/**
 * How the vault can represent an n8n credential type — generated-table lookup
 * by the ACTUAL injection recipe, with the name heuristic surviving only for
 * types newer than the table.
 */
function vaultCredentialInfo(sourceType: string): VaultCredentialInfo {
  const entry = lookupN8nCredential(sourceType)
  if (!entry) return { credentialType: vaultTypeFor(sourceType) }
  switch (entry.type) {
    case 'unsupported':
      return { sourceDisplayName: entry.displayName, unsupported: { reason: entry.reason } }
    case 'apiKeyHeader':
      return { credentialType: 'apiKeyHeader', suggestedHeaderName: entry.headerName, sourceDisplayName: entry.displayName }
    case 'apiKeyQuery':
      return { credentialType: 'apiKeyQuery', suggestedQueryParam: entry.queryParam, sourceDisplayName: entry.displayName }
    case 'custom':
      return { credentialType: 'custom', suggestedEntries: entry.entries, sourceDisplayName: entry.displayName }
    default:
      return { credentialType: entry.type, sourceDisplayName: entry.displayName }
  }
}

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

/** n8n slackTrigger event values → Sublime slack trigger event kinds. */
const SLACK_EVENT_MAP: Record<string, string[]> = {
  app_mention: ['mention'],
  message: ['channel_message'],
  any_event: ['mention', 'dm', 'channel_message'],
}

function triggerFor(node: N8nNode, warnings: string[]): FlowTrigger {
  const base = baseType(node.type)
  if (base === 'webhook') return { type: 'webhook' }
  if (base === 'scheduleTrigger' || base === 'cron') return scheduleTriggerFrom(node, warnings)
  if (base === 'slackTrigger') {
    const requested = Array.isArray(node.parameters.trigger) ? node.parameters.trigger.map(asString) : []
    const events = Array.from(new Set(requested.flatMap((value) => SLACK_EVENT_MAP[value] ?? [])))
    const unmapped = requested.filter((value) => !SLACK_EVENT_MAP[value])
    if (unmapped.length) warnings.push(`Slack trigger events without an equivalent were dropped: ${unmapped.join(', ')}.`)
    return { type: 'slack', events: events.length ? events : ['mention'] }
  }
  return { type: 'manual' }
}

/** Collapse an n8n resourceLocator ({__rl, value}) to its value. */
function rlValue(raw: unknown): string {
  return isRecord(raw) && raw.__rl ? asString(raw.value) : asString(raw)
}

/** resourceLocator display name (sheet tabs are referenced by NAME in A1 ranges). */
function rlName(raw: unknown): string {
  return isRecord(raw) && raw.__rl ? asString(raw.cachedResultName) || asString(raw.value) : asString(raw)
}

/** The ai_* sub-nodes attached to one agent/chain node. */
type AiAttachments = { models: N8nNode[]; tools: N8nNode[]; memory: N8nNode[] }

// --- n8n HTTP tool sub-nodes → configured agent endpoints -------------------

/** $fromAI("key", …) — the model-fillable slot inside n8n tool parameters. */
const FROM_AI = /\$fromAI\s*\(\s*(['"`])([A-Za-z0-9_-]{1,64})\1[^)]*\)/gi

/** {placeholder} (toolHttpRequest's own slot syntax), never touching {{…}}. */
const BRACE_PLACEHOLDER = /\{(?!\{)([A-Za-z_][\w-]*)\}(?!\})/g

/** Convert n8n model-fillable slots to {{input.…}} and drop the '=' prefix. */
function toInputTemplate(value: string): string {
  const converted = value.replace(FROM_AI, (_segment, _quote, key: string) => `{{input.${key.replace(/\W/g, '_')}}}`)
  return converted.startsWith('=') ? converted.slice(1) : converted
}

/**
 * Keypair editors, both dialects: the langchain tool's
 * { values: [{ name, valueProvider, value }] } (model-provided entries become
 * {{input.…}}) and the standard { parameters: [{ name, value }] }.
 */
function httpToolPairsJson(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined
  const entries = Array.isArray(raw.values) ? raw.values : Array.isArray(raw.parameters) ? raw.parameters : []
  const out: Record<string, string> = {}
  for (const entry of entries) {
    if (!isRecord(entry) || !entry.name) continue
    const key = asString(entry.name)
    const provider = asString(entry.valueProvider)
    out[key] = provider === 'modelRequired' || provider === 'modelOptional'
      ? `{{input.${key.replace(/\W/g, '_')}}}`
      : toInputTemplate(asString(entry.value))
  }
  return Object.keys(out).length ? JSON.stringify(out) : undefined
}

/** toolHttpRequest / httpRequestTool → an AgentHttpTool; null when unusable. */
function httpToolFromN8n(node: N8nNode): AgentHttpTool | null {
  const p = node.parameters
  const method = HTTP_METHODS.includes(asString(p.method).toUpperCase() as typeof HTTP_METHODS[number])
    ? (asString(p.method).toUpperCase() as typeof HTTP_METHODS[number]) : 'GET'
  const url = toInputTemplate(asString(p.url)).replace(BRACE_PLACEHOLDER, '{{input.$1}}')
  const query = httpToolPairsJson(p.parametersQuery ?? p.queryParameters)
    ?? (p.jsonQuery ? toInputTemplate(asString(p.jsonQuery)) : undefined)
  const headers = httpToolPairsJson(p.parametersHeaders ?? p.headerParameters)
    ?? (p.jsonHeaders ? toInputTemplate(asString(p.jsonHeaders)) : undefined)
  const body = httpToolPairsJson(p.parametersBody ?? p.bodyParameters)
    ?? (p.jsonBody ?? p.body ? toInputTemplate(asString(p.jsonBody ?? p.body)) : undefined)
  const candidate = {
    id: node.id || node.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name: node.name,
    description: asString(p.toolDescription),
    config: {
      method, url,
      ...(query ? { query, sendQuery: true } : {}),
      ...(headers ? { headers, sendHeaders: true } : {}),
      ...(body ? { body, sendBody: true } : {}),
    },
  }
  const parsed = agentHttpToolSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

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
  const httpTools: AgentHttpTool[] = []
  for (const tool of attach.tools) {
    const toolBase = baseType(tool.type)
    if (toolBase === 'mcpClientTool') {
      const endpoint = asString(tool.parameters.endpointUrl) || asString(tool.parameters.sseEndpoint)
      warnings.push(`"${node.name}" used an MCP server tool ("${tool.name}"${endpoint ? ` at ${endpoint}` : ''}) — connect that MCP server in Settings → Integrations, then add it to the agent.`)
      continue
    }
    if (toolBase === 'httpRequestTool' || toolBase === 'toolHttpRequest') {
      // Custom HTTP tools convert into configured agent endpoints —
      // $fromAI()/{placeholder} slots become {{input.…}} tool inputs.
      const converted = httpTools.length < MAX_AGENT_HTTP_TOOLS ? httpToolFromN8n(tool) : null
      if (converted) httpTools.push(converted)
      else warnings.push(`"${node.name}" used a custom HTTP tool ("${tool.name}") that could not be converted — configure it under the agent's HTTP API endpoints.`)
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
    ...(httpTools.length ? { httpTools } : {}),
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

/**
 * n8n JavaScript code runs against ITEM WRAPPERS ({json: …}) and returns
 * [{json: …}] rows; Sublime's code runner feeds plain values and returns the
 * value directly. This shim bridges the dialects at import time so pasted
 * n8n code runs unchanged: inbound items are wrapped, $input/$json take the
 * n8n shape, and a returned wrapper array unwraps back to plain values.
 */
function withN8nCodeShim(code: string): string {
  return [
    '// n8n compatibility shim (added on import): n8n code reads {json}-wrapped',
    '// items and returns [{json}] rows; this flow feeds plain values.',
    'return await (async (__rawItems) => {',
    "  const items = __rawItems.map((v) => (v && typeof v === 'object' && !Array.isArray(v) && 'json' in v ? v : { json: v }))",
    "  const __curr = typeof item === 'undefined' || item === undefined ? (items[0] ?? { json: undefined }) : (item && typeof item === 'object' && 'json' in item ? item : { json: item })",
    '  const $input = Object.freeze({ all: () => items, first: () => items[0], last: () => items[items.length - 1], item: __curr })',
    '  const $json = __curr.json',
    '  const __out = await (async () => {',
    code,
    '  })()',
    "  const __unwrap = (v) => (v && typeof v === 'object' && !Array.isArray(v) && 'json' in v ? v.json : v)",
    '  return Array.isArray(__out) ? __out.map(__unwrap) : __unwrap(__out)',
    '})(items)',
  ].join('\n')
}

/** n8n Python's `_input` item API, recreated over the runner's `_items`. */
const PYTHON_INPUT_SHIM = [
  '# n8n compatibility shim (added on import)',
  'class _SublimeItem:',
  '    def __init__(self, json):',
  '        self.json = json',
  'class _SublimeInput:',
  '    def all(self):',
  '        return [_SublimeItem(x) for x in _items]',
  '    def first(self):',
  '        return _SublimeItem(_items[0]) if _items else None',
  '    def last(self):',
  '        return _SublimeItem(_items[-1]) if _items else None',
  '_input = _SublimeInput()',
  '',
].join('\n')

/**
 * Merge → a generated JOIN over the parents' outputs. The code step's items
 * resolve to [leftOutput, rightOutput] (multiple parents), so every n8n merge
 * mode reduces to plain list algebra instead of being dropped.
 */
function mergeJoinCode(p: Record<string, unknown>): string {
  const mode = asString(p.mode) || 'append'
  const combineBy = asString(p.combineBy) || 'combineByFields'
  const pairsRaw = isRecord(p.mergeByFields) && Array.isArray(p.mergeByFields.values) ? p.mergeByFields.values : []
  let matchPairs = pairsRaw.flatMap((entry) => isRecord(entry) && entry.field1
    ? [{ left: asString(entry.field1), right: asString(entry.field2 ?? entry.field1) }] : [])
  if (!matchPairs.length) {
    matchPairs = asString(p.fieldsToMatchString).split(',').map((field) => field.trim()).filter(Boolean)
      .map((field) => ({ left: field, right: field }))
  }
  return [
    `const mode = ${JSON.stringify(mode === 'combine' ? combineBy : mode)};`,
    `const matchPairs = ${JSON.stringify(matchPairs)};`,
    'const lists = items.map((v) => (Array.isArray(v) ? v : v == null ? [] : [v]));',
    'const left = lists[0] ?? [];',
    'const right = lists[1] ?? [];',
    "if (mode === 'append') return lists.flat();",
    "if (mode === 'chooseBranch') return left;",
    "if (mode === 'combineByPosition') return left.map((l, i) => ({",
    "  ...(l && typeof l === 'object' ? l : { value: l }),",
    "  ...(right[i] && typeof right[i] === 'object' ? right[i] : right[i] === undefined ? {} : { value2: right[i] }),",
    '}));',
    "if (mode === 'combineAll') { const out = []; for (const l of left) for (const r of right) out.push({ ...l, ...r }); return out; }",
    'const out = [];',
    'for (const l of left) {',
    '  const match = right.find((r) => matchPairs.every((pair) => l?.[pair.left] === r?.[pair.right]));',
    '  out.push(match ? { ...l, ...match } : l);',
    '}',
    'return out;',
  ].join('\n')
}

type Mapped =
  | { kind: 'node'; node: FlowNode; stub?: true }
  | { kind: 'drop' } // noOp/stickyNote — rewire straight through

function mapNode(node: N8nNode, id: string, warnings: string[]): Mapped {
  const p = node.parameters
  const base = baseType(node.type)
  const label = node.name

  // The integration tail: import as an honest HTTP stub. The original type +
  // parameters travel in the note so the API call can be rebuilt.
  const stub = (): Mapped => {
    const note = `Imported from n8n node "${node.type}". Rebuild this step as the equivalent API request.\nOriginal parameters:\n${JSON.stringify(p, null, 2)}`.slice(0, 4000)
    return {
      kind: 'node', stub: true,
      node: { id, type: 'http', data: { label, note, method: 'GET', url: '' } },
    }
  }

  if (base === 'stickyNote' || base === 'noOp' || base === 'executionData') {
    return { kind: 'drop' }
  }
  if (base === 'merge') {
    return { kind: 'node', node: { id, type: 'code', data: { label, language: 'javascript', mode: 'allItems', code: mergeJoinCode(p) } } }
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
      const usesCredential = Boolean(p.authentication && p.authentication !== 'none')
      if (usesCredential) {
        warnings.push(`"${label}" used n8n credentials — attach a vault credential to this HTTP step.`)
      }
      // n8n runs every node once per incoming item; a $json reference is the
      // tell. forEachItem reproduces that fan-out (harmless on single items).
      const perItem = [p.url, p.jsonBody, p.body, p.jsonQuery, p.jsonHeaders,
        JSON.stringify(p.queryParameters ?? ''), JSON.stringify(p.headerParameters ?? ''), JSON.stringify(p.bodyParameters ?? '')]
        .some((value) => typeof value === 'string' && value.includes('$json'))
      const options = isRecord(p.options) ? p.options : {}
      const redirect = isRecord(options.redirect) && isRecord(options.redirect.redirect) ? options.redirect.redirect : undefined
      const responseFormat = isRecord(options.response) && isRecord(options.response.response) ? asString(options.response.response.responseFormat) : ''
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
            // n8n "file" responses → base64 body with size/content-type.
            ...(responseFormat === 'file' ? { responseType: 'binary' as const } : {}),
            ...(perItem ? { forEachItem: true } : {}),
            // Auth prefill: user-grant OAuth types our runtime can serve from
            // an existing Nango connection become predefined-connection auth
            // (runnable once the integration is connected); everything else
            // pre-sets the vault picker (the credential itself never travels).
            ...(usesCredential ? (() => {
              const nangoId = NANGO_CREDENTIAL_MAP[asString(p.nodeCredentialType).toLowerCase()]
              if (nangoId) return { authMode: 'predefined' as const, connectionId: nangoId }
              const info = vaultCredentialInfo(asString(p.nodeCredentialType ?? p.genericAuthType))
              // Unsupported (programmatic) auth: pre-setting a type that can
              // never work is worse than leaving the picker open.
              return {
                authMode: 'generic' as const,
                ...(info.credentialType ? { credentialType: info.credentialType } : {}),
              }
            })() : {}),
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
      // n8n Filter keeps matching ITEMS — splitItems reproduces that exactly.
      return { kind: 'node', node: { id, type: 'filter', data: { label, match, clauses, splitItems: true } } }
    }
    case 'switch': {
      // Expression mode: the output expression yields a 0-based index — one
      // case per output comparing the expression against its index.
      if (asString(p.mode) === 'expression') {
        const count = Math.max(1, Math.min(20, Number(p.numberOutputs) || 1))
        const expression = asString(p.output)
        const cases = Array.from({ length: count }, (_unused, index) => ({
          id: `case-${index}`, left: expression, op: 'eq' as ConditionOp, right: String(index),
        }))
        return { kind: 'node', node: { id, type: 'switch', data: { label, cases } } }
      }
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
    case 'code': case 'function': case 'functionItem': {
      const isPython = asString(p.language).startsWith('python')
      const rawCode = asString(p.jsCode ?? p.pythonCode ?? p.functionCode)
      const pythonCode = isPython && rawCode.includes('_input') ? PYTHON_INPUT_SHIM + rawCode : rawCode
      return {
        kind: 'node',
        node: {
          id, type: 'code',
          data: {
            label,
            language: isPython ? 'python' : 'javascript',
            mode: asString(p.mode) === 'runOnceForEachItem' ? 'eachItem' : 'allItems',
            code: isPython ? pythonCode : !rawCode ? rawCode : withN8nCodeShim(rawCode),
          },
        },
      }
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
    // Common delivery integrations map to NATIVE tool steps (nango plane ids
    // are portable), so a connected workspace runs them immediately and a
    // disconnected one gets the standard missing-integration prompt — far
    // better than an HTTP stub.
    case 'slack': {
      if ((asString(p.resource) || 'message') === 'message' && (asString(p.operation) || 'post') === 'post') {
        const channel = isRecord(p.channelId) ? asString(p.channelId.value) : asString(p.channelId ?? p.channel)
        return {
          kind: 'node',
          node: {
            id, type: 'tool',
            data: { label, connectionId: 'nango:slack', toolName: 'slack_post_message', args: JSON.stringify({ channel, text: asString(p.text) }) },
          },
        }
      }
      warnings.push(`"${label}" used a Slack action beyond posting a message — rebuild it with your Slack connection's actions.`)
      return stub()
    }
    case 'gmail': {
      if ((asString(p.resource) || 'message') === 'message' && (asString(p.operation) || 'send') === 'send') {
        return {
          kind: 'node',
          node: {
            id, type: 'tool',
            data: {
              label, connectionId: 'nango:gmail', toolName: 'gmail_send_email',
              args: JSON.stringify({ to: asString(p.sendTo ?? p.to), subject: asString(p.subject), body: asString(p.message ?? p.body) }),
            },
          },
        }
      }
      warnings.push(`"${label}" used a Gmail action beyond sending an email — rebuild it with your Gmail connection's actions.`)
      return stub()
    }
    case 'googleSheets': {
      const operation = asString(p.operation) || 'read'
      const spreadsheetId = rlValue(p.documentId)
      const range = rlName(p.sheetName) || 'Sheet1'
      const toolName = operation === 'read' ? 'sheets_get_values'
        : operation === 'update' ? 'sheets_update_values'
        : operation === 'append' || operation === 'appendOrUpdate' ? 'sheets_append_rows'
        : null
      if (toolName && spreadsheetId) {
        if (toolName !== 'sheets_get_values') {
          warnings.push(`"${label}": map the row values on this Sheets step — n8n's column mapper does not translate.`)
        }
        return {
          kind: 'node',
          node: {
            id, type: 'tool',
            data: { label, connectionId: 'nango:sheets', toolName, args: JSON.stringify({ spreadsheet_id: spreadsheetId, range }) },
          },
        }
      }
      warnings.push(`"${label}" used a Sheets action beyond read/update/append — rebuild it with your Sheets connection's actions.`)
      return stub()
    }
    case 'salesforce': {
      if (asString(p.operation) === 'create') {
        const resource = asString(p.resource) || 'lead'
        warnings.push(`"${label}": map the record fields on this Salesforce step — n8n's per-field params do not translate.`)
        return {
          kind: 'node',
          node: {
            id, type: 'tool',
            data: {
              label, connectionId: 'nango:salesforce', toolName: 'salesforce_create_record',
              args: JSON.stringify({ sobject: resource.charAt(0).toUpperCase() + resource.slice(1), fields: {} }),
            },
          },
        }
      }
      warnings.push(`"${label}" used a Salesforce action beyond create — rebuild it with your Salesforce connection's actions.`)
      return stub()
    }
    // Legacy Item Lists node (split into Limit/Sort/Split Out/… in n8n 1.x):
    // its operations route onto the modern generators — the param names are
    // identical because those nodes were extracted from this one.
    case 'itemLists': {
      const operation = asString(p.operation) || 'splitOutItems'
      const modernBase = {
        splitOutItems: 'splitOut', limit: 'limit', sort: 'sort',
        removeDuplicates: 'removeDuplicates', aggregateItems: 'aggregate', concatenateItems: 'aggregate',
      }[operation]
      if (!modernBase) {
        warnings.push(`"${label}" used Item Lists "${operation}" (summarize-style) — no direct equivalent; rebuild it as a Code step.`)
        return stub()
      }
      const code = dataNodeCode(modernBase, p, warnings, label)
      if (code !== null) {
        return { kind: 'node', node: { id, type: 'code', data: { label, language: 'javascript', mode: 'allItems', code } } }
      }
      return stub()
    }
    default: {
      if (DATA_CODE_NODES.has(base)) {
        const code = dataNodeCode(base, p, warnings, label)
        if (code !== null) {
          return { kind: 'node', node: { id, type: 'code', data: { label, language: 'javascript', mode: 'allItems', code } } }
        }
      }
      return stub()
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

const JSON_SEGMENT = /^\s*\$json\s*((?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[\d+\]|\[(?:"[^"]*"|'[^']*')\])*)\s*$/
const NODE_SEGMENT = /^\s*\$node\[(["'])([\s\S]+?)\1\]\.json\s*((?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[\d+\])*)\s*$/
// Modern cross-node syntax: $('Node Name').first().json.x / .last() / .item
const NODE_CALL_SEGMENT = /^\s*\$\(\s*(["'])([\s\S]+?)\1\s*\)\s*(?:\.(?:first|last)\(\)|\.item)?\.json\s*((?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[\d+\])*)\s*$/
// n8n instance environment variables — materialized as variable steps.
const ENV_SEGMENT = /^\s*\$env\.([A-Za-z_]\w*)\s*$/

// ——— js: fallback tier ———————————————————————————————————————————————
// n8n globals with no Sublime equivalent, and n8n string/date extension
// methods that would throw in plain JS — segments using them stay verbatim.
const JS_DENIED = /\$items\b|\$runIndex\b|\$itemMatching\b|\$binary\b|\$execution\b|\$workflow\b|\$prevNode\b|\$fromAI\b|\$if\b|\$min\b|\$max\b|\.toDateTime\(|\.removeTags\(|\.extractEmail\(|\.extractDomain\(|\.extractUrl\(|\.beginningOf\(|\.endOfMonth\(|\.plus\(|\.minus\(|\.format\(|\.toFormat\(/
// Non-anchored variants of the cross-node reference forms.
const NODE_ANY = /\$node\[(["'])([\s\S]+?)\1\]\.json/g
const NODE_CALL_ANY = /\$\(\s*(["'])([\s\S]+?)\1\s*\)\s*(?:\.(?:first|last)\(\)|\.item)?\.json/g
const ENV_ANY = /\$env\.([A-Za-z_]\w*)/g

/**
 * Best-effort n8n expression → Sublime template translation. All-or-nothing
 * per string: a `=`-prefixed string converts only when EVERY `{{ … }}` segment
 * is a plain `$json`/`$node["…"]` data reference — `$json` needs exactly one
 * main predecessor to name the source step (the trigger predecessor becomes
 * `trigger.input`). Function calls, `$now`, ternaries, … keep the original
 * string verbatim; half-translated expressions would be worse than honest
 * untranslated ones.
 */
function translateExpressions(
  nodes: FlowNode[],
  edges: FlowEdge[],
  idByName: Map<string, string>,
  warnings: string[],
): Set<string> {
  const predecessors = new Map<string, Set<string>>()
  for (const edge of edges) {
    const set = predecessors.get(edge.target) ?? new Set<string>()
    set.add(edge.source)
    predecessors.set(edge.target, set)
  }
  let untranslated = 0
  const envVars = new Set<string>()

  const translateString = (value: string, nodeId: string, itemScoped: boolean): string => {
    // '=' marks an n8n expression; one with no {{…}} segments is a plain
    // literal that only needs the marker stripped.
    if (value.startsWith('=') && !value.includes('{{')) return value.slice(1)
    if (!value.startsWith('=') || !value.includes('{{')) return value
    const preds = predecessors.get(nodeId)
    // forEachItem steps see one item at a time — $json IS that item.
    const jsonBase = itemScoped
      ? 'item'
      : preds?.size === 1
        ? (() => { const [pred] = preds; return pred === 'trigger' ? 'trigger.input' : `step.${pred}.output` })()
        : null
    // Same reference in the {{js:}} scope, where step.<id> IS the output
    // (no `.output` suffix) and ids need bracket form for JS syntax.
    const jsJsonBase = itemScoped
      ? 'item'
      : preds?.size === 1
        ? (() => { const [pred] = preds; return pred === 'trigger' ? 'trigger.input' : `step[${JSON.stringify(pred)}]` })()
        : null

    /**
     * Computed segment → a QuickJS `{{js:}}` expression, or null to keep the
     * string verbatim. Constraints: every n8n reference must rewrite to the
     * runtime scope ($json/step/vars/trigger/item), no deny-listed globals or
     * extension methods, and NO braces — the template token grammar
     * ({{([^{}]+?)}}) cannot carry object literals or block bodies.
     */
    const toJs = (inner: string): string | null => {
      if (JS_DENIED.test(inner)) return null
      let ok = true
      let out = inner
      const rewriteNode = (match: string, _quote: string, name: string) => {
        const referencedId = idByName.get(name)
        if (!referencedId) { ok = false; return match }
        return `step[${JSON.stringify(referencedId)}]`
      }
      out = out.replace(NODE_CALL_ANY, rewriteNode)
      out = out.replace(NODE_ANY, rewriteNode)
      out = out.replace(ENV_ANY, (_match, name: string) => { envVars.add(name); return `vars.${name}` })
      // Luxon DateTimes: only bare interpolation and .toISO() have loss-free
      // JS equivalents; other methods hit the deny-list or the residual check.
      out = out.replace(/\$now\.toISO\(\)/g, 'new Date().toISOString()')
      out = out.replace(/\$today\.toISO\(\)/g, 'new Date(new Date().toDateString()).toISOString()')
      out = out.replace(/\$now\b(?!\s*[.(])/g, 'new Date().toISOString()')
      out = out.replace(/\$today\b(?!\s*[.(])/g, 'new Date(new Date().toDateString()).toISOString()')
      if (/\$json\b/.test(out)) {
        if (!jsJsonBase) return null
        out = out.replace(/\$json\b/g, jsJsonBase)
      }
      if (!ok) return null
      if (/[{}]/.test(out)) return null
      // Any surviving $-global means an unmapped n8n reference.
      if (/\$[A-Za-z_(]/.test(out)) return null
      return out.trim() || null
    }
    let allTranslated = true
    const converted = value.slice(1).replace(/\{\{([\s\S]*?)\}\}/g, (segment, inner: string) => {
      const jsonMatch = JSON_SEGMENT.exec(inner)
      if (jsonMatch) {
        if (!jsonBase) { allTranslated = false; return segment }
        return `{{${jsonBase}${jsonMatch[1] ?? ''}}}`
      }
      // Cross-node refs, both dialects: $node["Name"].json.x and $('Name').first().json.x
      // (group layout is identical: name at index 2, path at index 3).
      const nodeMatch = NODE_SEGMENT.exec(inner) ?? NODE_CALL_SEGMENT.exec(inner)
      if (nodeMatch) {
        const referencedId = idByName.get(nodeMatch[2])
        if (!referencedId) { allTranslated = false; return segment }
        return `{{step.${referencedId}.output${nodeMatch[3] ?? ''}}}`
      }
      const envMatch = ENV_SEGMENT.exec(inner)
      if (envMatch) {
        envVars.add(envMatch[1])
        return `{{var.${envMatch[1]}}}`
      }
      // Computed expression: rewrite the references and hand the rest to the
      // QuickJS token, instead of abandoning the whole string.
      const js = toJs(inner)
      if (js !== null) return `{{js: ${js}}}`
      allTranslated = false
      return segment
    })
    if (!allTranslated) { untranslated += 1; return value }
    return converted
  }

  const walk = (value: unknown, nodeId: string, itemScoped: boolean): unknown => {
    if (typeof value === 'string') return translateString(value, nodeId, itemScoped)
    if (Array.isArray(value)) return value.map((entry) => walk(entry, nodeId, itemScoped))
    if (isRecord(value)) {
      const out: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(value)) out[key] = walk(entry, nodeId, itemScoped)
      return out
    }
    return value
  }

  for (const node of nodes) {
    if (node.type === 'trigger') continue
    const itemScoped = (node.data as { forEachItem?: boolean }).forEachItem === true
    // User-authored code runs against `items`, and stub notes are a verbatim
    // record — neither is template-bearing.
    const skip = node.type === 'code' ? new Set(['code', 'note']) : new Set(['note'])
    const data = node.data as Record<string, unknown>
    for (const [key, entry] of Object.entries(data)) {
      if (skip.has(key)) continue
      // Tool args are a JSON STRING whose values may carry expressions — the
      // '='-prefix check lives per-value, so translate inside the parsed form.
      if (node.type === 'tool' && key === 'args' && typeof entry === 'string' && entry.trim()) {
        try {
          const parsed = JSON.parse(entry)
          data[key] = JSON.stringify(walk(parsed, node.id, itemScoped))
        } catch {
          data[key] = translateString(entry, node.id, itemScoped)
        }
        continue
      }
      data[key] = walk(entry, node.id, itemScoped)
    }
  }

  if (untranslated > 0) {
    warnings.push(`${untranslated} n8n expression(s) could not be translated and were kept as-is — rewrite them as {{step.…}} or {{input.…}} references.`)
  }
  return envVars
}

/** Fields whose whole-string computed expressions may extract into code steps. */
const COMPUTED_FIELDS = new Set(['url', 'query', 'headers', 'body', 'graphqlVariables', 'cookie', 'input', 'text', 'value', 'message', 'reason'])

const EXPR_PRELUDE = [
  '// computed n8n expression (extracted on import)',
  'const first = items[0]',
  "const $json = first && typeof first === 'object' && 'json' in first ? first.json : first",
  'const __dateShim = (d) => Object.assign(d, { toISO: () => d.toISOString(), format: () => d.toISOString() })',
  'const $now = __dateShim(new Date())',
  'const $today = __dateShim(new Date(new Date().toDateString()))',
].join('\n')

/**
 * n8n expressions are full JavaScript; our templates are data paths. A field
 * that is ONE computed `={{ … }}` segment (function calls, arithmetic — not a
 * plain path) extracts into a generated code step spliced before the node,
 * and the field becomes a reference to that step's output. Only unambiguous
 * cases move: single main predecessor, no cross-node/$env refs, not
 * item-scoped. Everything else keeps the verbatim-plus-warning behavior.
 */
function extractComputedExpressions(
  nodes: FlowNode[],
  edges: FlowEdge[],
  usedIds: Set<string>,
  nextEdgeId: () => string,
): void {
  const predecessors = new Map<string, string[]>()
  for (const edge of edges) {
    predecessors.set(edge.target, [...(predecessors.get(edge.target) ?? []), edge.source])
  }
  for (const node of [...nodes]) {
    if (node.type === 'trigger' || node.type === 'code') continue
    const parents = Array.from(new Set(predecessors.get(node.id) ?? []))
    if (parents.length !== 1) continue
    const itemScoped = (node.data as { forEachItem?: boolean }).forEachItem === true
    let currentPred = parents[0]
    let sequence = 0
    const data = node.data as Record<string, unknown>
    const computedKeys = Object.entries(data).filter(([key, value]) =>
      COMPUTED_FIELDS.has(key) && typeof value === 'string' && /^=\{\{[\s\S]+\}\}$/.test((value as string).trim()))
    for (const [key, raw] of computedKeys) {
      const value = raw as string
      const expression = /^=\{\{([\s\S]+)\}\}$/.exec(value.trim())![1].trim()
      // Plain data paths translate in place; cross-node/$env refs can't move
      // into a code step (no cross-step access there).
      if (JSON_SEGMENT.test(expression)) continue
      if (/\$\(|\$node|\$env|\{\{/.test(expression)) continue
      if (itemScoped) {
        // Per-item step: the code step computes the expression for EVERY item
        // and the field becomes {{item}} — the whole computed value. Only
        // sound when this is the node's single item-scoped field.
        const otherItemRefs = Object.entries(data).some(([otherKey, otherValue]) =>
          otherKey !== key && typeof otherValue === 'string' && (otherValue.includes('$json') || otherValue.includes('{{item')))
        if (otherItemRefs || computedKeys.length > 1) continue
      }
      let codeId = `${node.id}-expr`
      for (let n = 2; usedIds.has(codeId); n += 1) codeId = `${node.id}-expr-${n}`
      usedIds.add(codeId)
      const code = itemScoped
        ? [
            EXPR_PRELUDE,
            'return items.map((__it) => {',
            "  const $json = __it && typeof __it === 'object' && 'json' in __it ? __it.json : __it",
            `  return (${expression})`,
            '})',
          ].join('\n')
        : `${EXPR_PRELUDE}\nreturn (${expression})`
      nodes.push({
        id: codeId, type: 'code',
        data: { label: `Compute ${key}`, language: 'javascript', mode: 'allItems', code },
      })
      const incoming = edges.find((edge) => edge.source === currentPred && edge.target === node.id)
      if (incoming) edges.splice(edges.indexOf(incoming), 1)
      // A branch label (condition true/false, switch case) rides the FIRST
      // hop — the code step inherits the branch, the node follows it plainly.
      edges.push({ id: nextEdgeId(), source: currentPred, target: codeId, ...(incoming?.branch ? { branch: incoming.branch } : {}) })
      edges.push({ id: nextEdgeId(), source: codeId, target: node.id })
      data[key] = itemScoped ? '{{item}}' : `{{step.${codeId}.output}}`
      currentPred = codeId
      sequence += 1
      if (sequence >= 4) break
    }
  }
}

const AI_ATTACHMENT_TYPES = new Set(['ai_languageModel', 'ai_tool', 'ai_memory', 'ai_outputParser', 'ai_embedding', 'ai_vectorStore', 'ai_retriever', 'ai_reranker', 'ai_textSplitter', 'ai_document'])
const AGENT_FAMILY = new Set(['agent', 'agentTool', 'chainLlm'])

export function fromN8nWorkflow(raw: unknown): ImportedFlow {
  const parsed = n8nWorkflowSchema.safeParse(raw)
  if (!parsed.success) throw new FlowImportError('This n8n workflow file is missing its nodes.', 'INVALID_GRAPH')
  if (parsed.data.nodes.length > 300) {
    throw new FlowImportError(`This workflow has ${parsed.data.nodes.length} nodes — the import limit is 300. Split it in n8n and import the parts.`, 'INVALID_GRAPH')
  }
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

  // Multiple triggers: Sublime flows have exactly one, so the workflow SPLITS
  // into one flow per trigger — each takes its reachable chain (shared tails
  // duplicated), which preserves every entry point's semantics instead of
  // firing every branch on every call.
  if (triggerNodes.length > 1) {
    const reachableFrom = (start: string): Set<string> => {
      const seen = new Set<string>([start])
      const queue = [start]
      while (queue.length) {
        const current = queue.shift()!
        const conns = workflow.connections[current]
        if (!isRecord(conns)) continue
        for (const bundles of Object.values(conns)) {
          if (!Array.isArray(bundles)) continue
          for (const bundle of bundles) {
            if (!Array.isArray(bundle)) continue
            for (const link of bundle) {
              if (isRecord(link) && typeof link.node === 'string' && !seen.has(link.node)) {
                seen.add(link.node)
                queue.push(link.node)
              }
            }
          }
        }
      }
      // Pull in ai_* sub-nodes attached to included nodes (fixpoint: a model
      // can attach to a tool that attaches to an agent).
      for (;;) {
        let grew = false
        for (const [sourceName, value] of Object.entries(workflow.connections)) {
          if (seen.has(sourceName) || !isRecord(value)) continue
          for (const [connType, bundles] of Object.entries(value)) {
            if (!AI_ATTACHMENT_TYPES.has(connType) || !Array.isArray(bundles)) continue
            const targets = bundles.flat().filter(isRecord).map((link) => link.node)
            if (targets.some((target) => typeof target === 'string' && seen.has(target))) {
              seen.add(sourceName)
              grew = true
            }
          }
        }
        if (!grew) break
      }
      return seen
    }
    const subWorkflowFor = (trigger: N8nNode, name: string) => {
      const included = reachableFrom(trigger.name)
      // Orphans (reachable from no trigger) ride with the primary flow.
      if (trigger === triggerNodes[0]) {
        const anyTrigger = new Set(triggerNodes.flatMap((entry) => [...reachableFrom(entry.name)]))
        for (const node of workflow.nodes) if (!anyTrigger.has(node.name)) included.add(node.name)
      }
      // A trigger wired downstream of ANOTHER trigger would leave two
      // triggers in the sub-workflow and recurse forever — every sub-flow
      // keeps exactly its own trigger.
      for (const other of triggerNodes) if (other !== trigger) included.delete(other.name)
      const connections: Record<string, unknown> = {}
      for (const [sourceName, value] of Object.entries(workflow.connections)) {
        if (!included.has(sourceName) || !isRecord(value)) continue
        const filtered: Record<string, unknown> = {}
        for (const [connType, bundles] of Object.entries(value)) {
          if (!Array.isArray(bundles)) continue
          filtered[connType] = bundles.map((bundle) =>
            Array.isArray(bundle) ? bundle.filter((link) => isRecord(link) && typeof link.node === 'string' && included.has(link.node)) : bundle)
        }
        connections[sourceName] = filtered
      }
      return { ...workflow, name, nodes: workflow.nodes.filter((node) => included.has(node.name)), connections }
    }
    const primary = fromN8nWorkflow(subWorkflowFor(triggerNodes[0], workflow.name ?? 'Imported n8n workflow'))
    const additionalFlows = triggerNodes.slice(1).map((trigger) =>
      fromN8nWorkflow(subWorkflowFor(trigger, `${workflow.name ?? 'Imported n8n workflow'} — ${trigger.name}`)))
    return {
      ...primary,
      warnings: Array.from(new Set([
        `This n8n workflow had ${triggerNodes.length} triggers — it was split into ${triggerNodes.length} flows, one per trigger (shared steps are duplicated into each).`,
        ...primary.warnings,
        ...additionalFlows.flatMap((flow) => flow.warnings.map((warning) => `[${flow.name}] ${warning}`)),
      ])),
      additionalFlows,
    }
  }

  const primaryTrigger: N8nNode | undefined = triggerNodes[0]

  const nodes: FlowNode[] = []
  const dropped = new Set<string>()
  const layout: NonNullable<FlowGraph['layout']> = {}
  // Steps that shared one n8n credential, grouped so a single vault
  // credential can bind to all of them after import.
  const credentialGroups = new Map<string, CredentialGroup>()
  const collectCredentials = (source: N8nNode, nodeId: string) => {
    const record = (sourceType: string, identity: string, name: string) => {
      // Nango-served OAuth types bind by connecting the integration (the step
      // already carries authMode 'predefined'), not by a vault credential.
      if (NANGO_CREDENTIAL_MAP[sourceType.toLowerCase()]) return
      const key = `${sourceType}:${identity || 'default'}`
      const existing = credentialGroups.get(key)
      const group = existing ?? (() => {
        const info = vaultCredentialInfo(sourceType)
        if (info.unsupported) {
          warnings.push(`n8n authenticates “${info.sourceDisplayName ?? sourceType}” programmatically — connect it as an integration or configure the step's auth manually.`)
        }
        return { key, sourceType, name: name || info.sourceDisplayName || sourceType, ...info, nodeIds: [] as string[] }
      })()
      group.nodeIds.push(nodeId)
      credentialGroups.set(key, group)
    }
    if (isRecord(source.credentials)) {
      for (const [sourceType, info] of Object.entries(source.credentials)) {
        record(sourceType, isRecord(info) ? asString(info.id) || asString(info.name) : '', isRecord(info) ? asString(info.name) : '')
      }
      return
    }
    // Template exports often carry no credentials object — the credential
    // TYPE on the http step (nodeCredentialType) still groups the steps.
    const p = source.parameters
    if (baseType(source.type) === 'httpRequest' && p.authentication && p.authentication !== 'none') {
      const sourceType = asString(p.nodeCredentialType ?? p.genericAuthType) || 'httpCredential'
      record(sourceType, '', sourceType)
    }
  }

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
    collectCredentials(node, id)
    if (mapped.stub) stubbedNodes.push({ nodeId: id, label: node.name, originalType: node.type })
  }

  // connections: { "<source name>": { main: [ [ {node,type,index} ] ] } }
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const edges: FlowEdge[] = []
  // splitInBatches output 1 is the LOOP branch (n8n outputNames ['done','loop']);
  // those edges are held aside for absorbLoopBodies instead of wired directly.
  const loopStarts: Array<{ loopId: string; target: string }> = []
  // onError continueErrorOutput adds an ERROR output at index 1 — held aside
  // and absorbed into an errorShield container after the graph is built.
  const errorStarts: Array<{ stepId: string; target: string }> = []
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
        if (
          outputIndex === 1 &&
          byName.get(sourceName)?.onError === 'continueErrorOutput' &&
          source && source.type !== 'condition' && source.type !== 'switch'
        ) {
          errorStarts.push({ stepId: sourceId, target: targetId })
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

  // Error shields: a step whose n8n error output fed a clean single chain
  // becomes an errorShield container — body is the step, fallback is the
  // chain — so the error path executes as n8n wired it instead of collapsing
  // to continue-on-error.
  for (const { stepId, target } of errorStarts) {
    const step = nodeById.get(stepId)
    if (!step) continue
    const fallback: string[] = []
    let current: string | undefined = target
    const visited = new Set<string>()
    let clean = true
    while (current && !visited.has(current)) {
      visited.add(current)
      if (!nodeById.has(current)) { clean = false; break }
      fallback.push(current)
      const outgoing = liveEdges.filter((edge) => edge.source === current)
      if (outgoing.length === 0) break
      if (outgoing.length !== 1) { clean = false; break }
      current = outgoing[0].target
    }
    if (!clean || fallback.length === 0) {
      liveEdges.push({ id: `e-${edgeSeq++}`, source: stepId, target })
      continue
    }
    let shieldId = `${stepId}-shield`
    for (let n = 2; usedIds.has(shieldId); n += 1) shieldId = `${stepId}-shield-${n}`
    usedIds.add(shieldId)
    const shield: FlowNode = {
      id: shieldId, type: 'errorShield',
      data: { label: `${(step.data as { label?: string }).label ?? step.type} guard`, body: [stepId], fallback },
    }
    nodes.push(shield)
    nodeById.set(shieldId, shield)
    for (const edge of liveEdges) {
      if (edge.target === stepId) edge.target = shieldId
      if (edge.source === stepId) edge.source = shieldId
    }
    const fallbackSet = new Set(fallback)
    liveEdges = liveEdges.filter((edge) => !fallbackSet.has(edge.source) && !fallbackSet.has(edge.target))
    // The shield handles failure now; continue-on-error would swallow it first.
    delete (step.data as Record<string, unknown>).onError
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

  // Numeric fallbackOutput: n8n routes unmatched items into an EXISTING rule
  // output; our switch follows the 'default' branch — wire default to the
  // same target as that rule's case edge.
  for (const node of nodes) {
    if (node.type !== 'switch') continue
    const source = byName.get([...idByName.entries()].find(([, mapped]) => mapped === node.id)?.[0] ?? '')
    const fallback = source && isRecord(source.parameters.options) ? source.parameters.options.fallbackOutput : undefined
    if (typeof fallback !== 'number') continue
    const target = liveEdges.find((edge) => edge.source === node.id && edge.branch === `case-${fallback}`)
    if (target && !liveEdges.some((edge) => edge.source === node.id && edge.branch === 'default')) {
      liveEdges.push({ id: `e-${edgeSeq++}`, source: node.id, target: target.target, branch: 'default' })
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

  extractComputedExpressions(nodes, finalEdges, usedIds, () => `e-${edgeSeq++}`)
  const envVars = translateExpressions(nodes, finalEdges, idByName, warnings)

  // n8n $env variables become variable-init steps chained right behind the
  // trigger — one obvious place to fill in each value instead of hunting
  // through expressions. The steps start empty; the warning says what to set.
  if (envVars.size > 0) {
    let previous = 'trigger'
    const formerTargets = finalEdges.filter((edge) => edge.source === 'trigger')
    for (const name of envVars) {
      let varId = `env-${name.toLowerCase()}`
      for (let n = 2; usedIds.has(varId); n += 1) varId = `env-${name.toLowerCase()}-${n}`
      usedIds.add(varId)
      const triggerIndex = nodes.findIndex((node) => node.id === previous)
      nodes.splice(triggerIndex + 1, 0, {
        id: varId, type: 'variable',
        data: { label: `Set ${name}`, op: 'initialize', name, varType: 'string', value: '' },
      })
      finalEdges.push({ id: `e-${edgeSeq++}`, source: previous, target: varId })
      previous = varId
      warnings.push(`Set the value of the "${name}" variable step — n8n environment variables do not travel with the export.`)
    }
    for (const edge of formerTargets) edge.source = previous
  }

  const graphParse = flowGraphSchema.safeParse({ nodes, edges: finalEdges, ...(Object.keys(layout).length ? { layout } : {}) })
  if (!graphParse.success) {
    const issue = graphParse.error.issues[0]
    throw new FlowImportError(`Converted n8n workflow failed validation: ${issue.path.join('.')} — ${issue.message}`, 'INVALID_GRAPH')
  }

  // n8n pinData ({ nodeName: [{json}, …] }) → per-node sample outputs. The
  // node ids resolve through the same name table as connections.
  const pins: Record<string, unknown> = {}
  const pinData = (workflow as { pinData?: unknown }).pinData
  if (isRecord(pinData)) {
    const liveIds = new Set(graphParse.data.nodes.map((node) => node.id))
    for (const [nodeName, rows] of Object.entries(pinData)) {
      const nodeId = idByName.get(nodeName)
      if (!nodeId || !liveIds.has(nodeId) || !Array.isArray(rows)) continue
      const values = rows.map((row) => (isRecord(row) && 'json' in row ? row.json : row))
      pins[nodeId] = values.length === 1 ? values[0] : values
    }
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
    ...(credentialGroups.size ? { credentialGroups: Array.from(credentialGroups.values()) } : {}),
    ...(Object.keys(pins).length ? { pins } : {}),
  }
}
