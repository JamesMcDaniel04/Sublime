import { z } from 'zod'
import { AGENT_RUN_TIMEOUT_MS } from '@/lib/agents/timeouts'

/** Comparison operators available to a condition node. */
export const CONDITION_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'matches'] as const
export type ConditionOp = (typeof CONDITION_OPS)[number]

/** Plain-english operator labels — the ONLY strings the UI may show for ops. */
export const CONDITION_OP_LABELS: Record<ConditionOp, string> = {
  eq: 'equals',
  neq: 'does not equal',
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  contains: 'contains',
  matches: 'matches pattern',
}

/** Field types a step's output schema can declare (for the datatree picker). */
export const FIELD_TYPES = ['string', 'number', 'boolean', 'object', 'array', 'any'] as const
export type FieldType = (typeof FIELD_TYPES)[number]
export const outputFieldSchema = z.object({ name: z.string(), type: z.enum(FIELD_TYPES).default('any'), description: z.string().optional() })
export type OutputField = z.infer<typeof outputFieldSchema>

/** A trigger input field: an OutputField plus whether the run must supply it. */
export const triggerInputFieldSchema = outputFieldSchema.extend({ required: z.boolean().optional() })
export type TriggerInputField = z.infer<typeof triggerInputFieldSchema>

/** A first-class input node's typed parameter. `default` is a templated/literal string coerced to `type` at runtime. */
export const inputParamSchema = z.object({
  name: z.string(),
  type: z.enum(FIELD_TYPES).default('string'),
  required: z.boolean().optional(),
  default: z.string().optional(),
  description: z.string().optional(),
})
export type InputParam = z.infer<typeof inputParamSchema>

/** A first-class output node's typed return field, bound from flow context via a templated `value`. */
export const outputFieldBindingSchema = z.object({
  name: z.string(),
  type: z.enum(FIELD_TYPES).default('any'),
  value: z.string(),
  description: z.string().optional(),
})
export type OutputFieldBinding = z.infer<typeof outputFieldBindingSchema>

const triggerNode = z.object({
  id: z.string(),
  type: z.literal('trigger'),
  data: z.object({ trigger: z.any().optional() }),
})
const agentNode = z.object({
  id: z.string(),
  type: z.literal('agent'),
  data: z.object({
    agentId: z.string(),
    label: z.string().optional(),
    note: z.string().optional(),
    input: z.string().optional(),
    // Auto-aggregation: when not false, the agent's runtime input is appended
    // with `{{upstream}}` (every prior data-bearing node's captured output) so
    // the agent works from the whole flow's context, not just its own input.
    // Set false to run the agent on its explicit input alone.
    includeUpstream: z.boolean().optional(),
    onError: z.enum(['stop', 'continue']).optional(),
    // Per-step reliability: retry the agent up to `retries` times with backoff,
    // and abort a single attempt after `timeoutMs`.
    retries: z.number().int().min(0).max(5).optional(),
    timeoutMs: z.number().int().min(1000).max(AGENT_RUN_TIMEOUT_MS).optional(),
    // Declared output schema — fields this step is expected to produce. Powers
    // the datatree field picker for downstream mapping.
    outputFields: z.array(outputFieldSchema).optional(),
    // Agent response contract: 'structured' appends a JSON instruction built
    // from outputFields and fails the step when the reply can't be parsed.
    responseFormat: z.enum(['text', 'structured']).optional(),
    // MS-parity "request human assistance when unsure": when false, a step
    // that pauses to ask a human fails instead of waiting.
    humanAssistance: z.boolean().optional(),
    // Inline-prompt mode: when agentId is blank, the step runs this prompt as an
    // ephemeral one-shot model call (no saved AgentTask). model overrides the
    // default; ignored when agentId is set (a saved agent brings its own model).
    prompt: z.string().optional(),
    model: z.string().optional(),
    disabled: z.boolean().optional(),
    mockOutput: z.any().optional(),
  }),
})
/** One left/op/right comparison; a condition ANDs/ORs a list of these. */
export const conditionClauseSchema = z.object({ left: z.string(), op: z.enum(CONDITION_OPS), right: z.string() })
const conditionNode = z.object({
  id: z.string(),
  type: z.literal('condition'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    // Multi-criteria: evaluate `clauses` with all (AND) / any (OR). The legacy
    // single left/op/right is still accepted and treated as a one-clause AND.
    match: z.enum(['all', 'any']).optional(),
    clauses: z.array(conditionClauseSchema).optional(),
    left: z.string().optional(),
    op: z.enum(CONDITION_OPS).optional(),
    right: z.string().optional(),
    // n8n-parity item routing: evaluate clauses PER ITEM of the input list
    // ({{item.…}} refs). Output becomes {matched, unmatched}; both branches
    // run when both sides are non-empty.
    splitItems: z.boolean().optional(),
    disabled: z.boolean().optional(),
  }),
})
// Ends the flow early with an optional message.
const stopNode = z.object({
  id: z.string(),
  type: z.literal('stop'),
  data: z.object({ label: z.string().optional(), reason: z.string().optional(), note: z.string().optional(), disabled: z.boolean().optional() }),
})
// Deterministic single MCP tool call against an org connection — no LLM in the
// loop. `args` is a JSON object literal whose string values may use {{tokens}}.
const toolNode = z.object({
  id: z.string(),
  type: z.literal('tool'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    connectionId: z.string(),
    toolName: z.string(),
    args: z.string().optional(),
    retries: z.number().int().min(0).max(5).optional(),
    timeoutMs: z.number().int().min(1000).max(120000).optional(),
    onError: z.enum(['stop', 'continue']).optional(),
    // Keep this node's output OUT of the `{{upstream}}` aggregate fed to
    // downstream agents (for noisy/irrelevant payloads). Default: included.
    excludeFromContext: z.boolean().optional(),
    // n8n-parity fan-out: run once per item of the predecessor's list output
    // ({{item.…}} refs resolve per iteration); output is the collected array.
    forEachItem: z.boolean().optional(),
    outputFields: z.array(outputFieldSchema).optional(),
    // Snapshot the discovered MCP action contract at authoring/publish time.
    // Runtime still calls the live tool name, while these fields keep the node
    // editable and its safety policy stable if discovery later changes.
    actionSchemaHash: z.string().optional(),
    actionDescription: z.string().optional(),
    actionInputSchema: z.any().optional(),
    actionOutputSchema: z.any().optional(),
    risk: z.enum(['read', 'write', 'destructive']).optional(),
    // Provider argument that accepts a caller-supplied idempotency token.
    // When configured, write retries and crash recovery are safe; otherwise a
    // potentially committed write is deliberately parked as ambiguous.
    idempotencyKeyArg: z.string().min(1).max(100).optional(),
    // Hold this step for a human before it fires. The run parks as `waiting`
    // and the reply that resumes it either releases or cancels the call —
    // deny-by-default. See features/flows/action-approval.ts.
    requireApproval: z.boolean().optional(),
    disabled: z.boolean().optional(),
    mockOutput: z.any().optional(),
  }),
})
// Plain HTTP request (webhook-out) step. URL/headers/body may use {{tokens}}.
// `connectionId` optionally names an MCP connection whose fresh OAuth token is
// injected as the Authorization header at fetch time — the token itself never
// enters the graph, run rows, or logs.
/**
 * The http step's data shape, exported standalone: agent HTTP API tools
 * (lib/agents/http-tools.ts) persist this exact config so the flows HTTP
 * editor UI and executor can be reused verbatim on the agent surface.
 */
/** Pagination page cap when `maxPages` is absent. The editor's seed and the
 *  runtime's fallback must both use this constant, or a flow saved without an
 *  explicit value paginates differently at run time than the editor showed.
 *  10 (conservative) rather than 100: no importer emits pagination without
 *  maxPages, so no flows in the wild rely on a larger implicit cap. */
export const DEFAULT_PAGINATION_MAX_PAGES = 10

export const httpStepDataSchema = z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    connectionId: z.string().optional(),
    // Generic auth (n8n-style generic credentials): basic / bearer / custom
    // header / query param. Values may use {{tokens}}; secret fields are
    // redacted in persisted run rows. An explicit Authorization header or a
    // connection token always wins over this option.
    auth: z.object({
      type: z.enum(['basic', 'bearer', 'header', 'query']),
      username: z.string().optional(),
      password: z.string().optional(),
      token: z.string().optional(),
      name: z.string().optional(),
      value: z.string().optional(),
    }).optional(),
    // Which auth path this step uses. 'predefined' = the connectionId above
    // (an MCP connection's OAuth token); 'generic' = credentialId, a row in the
    // reusable vault. Absent = today's behaviour, inferred from which field is
    // set, so every existing graph keeps working untouched.
    authMode: z.enum(['none', 'predefined', 'generic']).optional(),
    // Generic auth type selected in the editor. Non-secret and useful before a
    // credential has been created; the credential id remains runtime truth.
    credentialType: z.enum(['basic', 'bearer', 'custom', 'digest', 'apiKeyHeader', 'oauth1', 'oauth2', 'apiKeyQuery']).optional(),
    // Opaque reference to a Credential row. The secret itself NEVER travels in
    // the graph — that is the whole point of the vault (see lib/credentials).
    credentialId: z.string().optional(),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).default('POST'),
    url: z.string(),
    query: z.string().optional(),
    sendQuery: z.boolean().optional(),
    queryMode: z.enum(['json', 'fields']).optional(),
    // How array query values serialize: tag=a&tag=b (repeat, default),
    // tag[]=a, tag[0]=a, or tag=a,b.
    queryArrayFormat: z.enum(['repeat', 'brackets', 'indices', 'comma']).optional(),
    headers: z.string().optional(),
    sendHeaders: z.boolean().optional(),
    headersMode: z.enum(['json', 'fields']).optional(),
    body: z.string().optional(),
    sendBody: z.boolean().optional(),
    cookie: z.string().optional(),
    bodyMode: z.enum(['json', 'text', 'raw', 'graphql', 'formUrlencoded', 'multipart', 'binary', 'none']).optional(),
    bodyInputMode: z.enum(['json', 'fields']).optional(),
    bodyContentType: z.string().optional(),
    graphqlVariables: z.string().optional(),
    responseType: z.enum(['auto', 'json', 'text', 'binary']).optional(),
    failOnHttpError: z.boolean().optional(),
    retries: z.number().int().min(0).max(5).optional(),
    timeoutMs: z.number().int().min(1000).max(120000).optional(),
    onError: z.enum(['stop', 'continue']).optional(),
    // Keep this API response OUT of the `{{upstream}}` aggregate fed to
    // downstream agents (for noisy/irrelevant payloads). Default: included.
    excludeFromContext: z.boolean().optional(),
    // n8n-parity fan-out: run once per item of the predecessor's list output
    // ({{item.…}} refs resolve per iteration); output is the collected array.
    forEachItem: z.boolean().optional(),
    outputFields: z.array(outputFieldSchema).optional(),
    retryDelayMs: z.number().int().min(0).max(60000).optional(),
    retryStatusCodes: z.array(z.number().int().min(100).max(599)).optional(),
    // Header accepted by this endpoint for provider-side deduplication (for
    // example Idempotency-Key). The runtime supplies a stable per-effect key.
    idempotencyKeyHeader: z.string().min(1).max(100).optional(),
    // Hold this request for a human before it fires — see the tool node's
    // matching flag and features/flows/action-approval.ts.
    requireApproval: z.boolean().optional(),
    followRedirects: z.boolean().optional(),
    maxRedirects: z.number().int().min(0).max(10).optional(),
    pagination: z.object({
      mode: z.enum(['off', 'page', 'cursor', 'nextUrl']).default('off'),
      pageParam: z.string().optional(),
      startPage: z.number().int().min(0).optional(),
      cursorParam: z.string().optional(),
      cursorPath: z.string().optional(),
      nextUrlPath: z.string().optional(),
      maxPages: z.number().int().min(1).max(1000).optional(),
      // Pause between page requests (rate-limit friendliness), and an explicit
      // complete-condition: stop when the value at this dotted response path
      // is truthy (e.g. `meta.isLastPage`) — checked before mode-specific
      // continuation.
      intervalMs: z.number().int().min(0).max(60000).optional(),
      stopPath: z.string().optional(),
    }).optional(),
    batch: z.object({ size: z.number().int().min(1).max(1000), delayMs: z.number().int().min(0).max(60000).optional() }).optional(),
    disabled: z.boolean().optional(),
    mockOutput: z.any().optional(),
})
const httpNode = z.object({
  id: z.string(),
  type: z.literal('http'),
  data: httpStepDataSchema,
})
const loopNode = z.object({
  id: z.string(),
  type: z.literal('loop'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    over: z.string(),
    concurrency: z.number().int().min(1).max(20).optional(),
    body: z.array(z.string()),
    // Loop-thread: keep ONE agent conversation across iterations (multi-turn
    // batch memory) instead of a fresh conversation each item. Forces sequential
    // execution (concurrency 1) — you cannot thread one conversation concurrently.
    threadAgent: z.boolean().optional(),
    disabled: z.boolean().optional(),
  }),
})
const parallelNode = z.object({
  id: z.string(),
  type: z.literal('parallel'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    branches: z.array(z.array(z.string())),
    // Reconvergence strategy for the branch outputs. Unset = today's opaque
    // keyed object { [branchHeadNodeId]: output } (byte-identical back-compat).
    // 'array' = outputs in branch order; 'object' = keyed by `labels`;
    // 'merge' = shallow-merge branch objects into one.
    join: z.enum(['object', 'array', 'merge']).optional(),
    labels: z.array(z.string()).optional(),
    disabled: z.boolean().optional(),
  }),
})
// Deterministic "Set fields": build an object from templated assignments. Its
// output is the assembled object; downstream steps map its fields.
// n8n-parity Code step: user-authored JavaScript (node:vm) or Python
// (Pyodide/WASM), run server-side by the engines in lib/code. `input` is a
// template resolving to the item list (default: the previous step's output);
// `mode` mirrors n8n — run once with all items, or once per item.
const codeNode = z.object({
  id: z.string(),
  type: z.literal('code'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    language: z.enum(['javascript', 'python']).default('javascript'),
    mode: z.enum(['allItems', 'eachItem']).default('allItems'),
    code: z.string().default(''),
    input: z.string().optional(),
    onError: z.enum(['stop', 'continue']).optional(),
    retries: z.number().int().min(0).max(5).optional(),
    timeoutMs: z.number().int().min(1000).max(60000).optional(),
    excludeFromContext: z.boolean().optional(),
    outputFields: z.array(outputFieldSchema).optional(),
    disabled: z.boolean().optional(),
    mockOutput: z.any().optional(),
  }),
})
const transformNode = z.object({
  id: z.string(),
  type: z.literal('transform'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    // `value` templates are resolved; JSON-looking results are parsed.
    fields: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
    // n8n-parity fan-out: build one object PER ITEM of the input list
    // ({{item.…}} refs); output is the collected array.
    forEachItem: z.boolean().optional(),
    outputFields: z.array(outputFieldSchema).optional(),
    // Keep this node's output OUT of the `{{upstream}}` aggregate. Default: included.
    excludeFromContext: z.boolean().optional(),
    disabled: z.boolean().optional(),
  }),
})
// Gate: continues only when the condition passes, else stops the flow (or, in a
// loop body, drops the current item from the collected results).
const filterNode = z.object({
  id: z.string(),
  type: z.literal('filter'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    match: z.enum(['all', 'any']).optional(),
    clauses: z.array(conditionClauseSchema).optional(),
    // n8n Filter parity: keep the MATCHING items of the input list (clauses
    // see {{item.…}}) and always continue — even with zero matches.
    splitItems: z.boolean().optional(),
    disabled: z.boolean().optional(),
  }),
})
// Multi-way branch: the first case whose condition matches routes to its edge
// (branch=case id); an unmatched signal follows the `default` edge.
const switchNode = z.object({
  id: z.string(),
  type: z.literal('switch'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    cases: z.array(z.object({ id: z.string(), label: z.string().optional(), left: z.string(), op: z.enum(CONDITION_OPS), right: z.string() })).default([]),
    disabled: z.boolean().optional(),
  }),
})

/** Operations a variable step can perform on the flow's symbol table. */
export const VARIABLE_OPS = ['initialize', 'set', 'increment', 'decrement', 'appendArray', 'appendString'] as const
export type VariableOp = (typeof VARIABLE_OPS)[number]
/** Types an Initialize variable step can declare (MS Copilot Studio parity). */
export const VARIABLE_TYPES = ['boolean', 'integer', 'float', 'string', 'object', 'array'] as const
export type VariableType = (typeof VARIABLE_TYPES)[number]
/** Display names for variable ops — the ONLY strings surfaces may show for them. */
export const VARIABLE_OP_LABELS: Record<VariableOp, string> = {
  initialize: 'Initialize variable',
  set: 'Set variable',
  increment: 'Increment variable',
  decrement: 'Decrement variable',
  appendArray: 'Append to array variable',
  appendString: 'Append to string variable',
}
/** Display names for variable types (the stored values stay lowercase). */
export const VARIABLE_TYPE_LABELS: Record<VariableType, string> = {
  boolean: 'Boolean',
  integer: 'Integer',
  float: 'Float',
  string: 'String',
  object: 'Object',
  array: 'Array',
}
// Typed symbol table step: initialize declares a variable (varType applies to
// initialize only, default 'string'); the other ops mutate one initialized
// earlier. `value` is templated; readable anywhere via {{var.<name>}}.
const variableNode = z.object({
  id: z.string(),
  type: z.literal('variable'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    op: z.enum(VARIABLE_OPS),
    name: z.string(),
    varType: z.enum(VARIABLE_TYPES).optional(),
    value: z.string().optional(),
    disabled: z.boolean().optional(),
  }),
})

/** Pure transforms a data operation step can perform (MS Data Operation parity). */
export const DATA_OPS = ['compose', 'parseJson', 'join', 'csvTable', 'htmlTable', 'slackMessage', 'filterArray', 'select', 'sort', 'limit', 'dedupe', 'splitOut'] as const
export type DataOp = (typeof DATA_OPS)[number]
// Deterministic data-shaping step between other steps: no LLM, no I/O. `input`
// is templated (usually an exact {{step.x.output}} token so structure survives);
// the op-specific extras are: `separator` (join), `schema` (parseJson — stored
// for the editor, not yet enforced), `clauses` (filterArray, evaluated per item
// against {{item.*}}), `fields` (select's per-item name/value mappings).
// NOTE: the existing `transform`/`filter` node types stay untouched; `data`
// supersedes them for new graphs (picker copy steers — Task 4).
const dataNode = z.object({
  id: z.string(),
  type: z.literal('data'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    op: z.enum(DATA_OPS),
    input: z.string().optional(),
    separator: z.string().optional(),
    schema: z.string().optional(),
    clauses: z.array(conditionClauseSchema).optional(),
    fields: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    // limit: how many items to keep (from the front).
    count: z.number().int().min(1).max(10000).optional(),
    // splitOut: the list-bearing field to fan out on (other fields carried).
    field: z.string().optional(),
    // n8n-parity fan-out: run the op once PER ITEM of the input list.
    forEachItem: z.boolean().optional(),
    // Keep this node's output OUT of the `{{upstream}}` aggregate. Default: included.
    excludeFromContext: z.boolean().optional(),
    disabled: z.boolean().optional(),
  }),
})

// MS-parity "Request information" (human review): a first-class pause with no
// agent involved. The flow stops, asks `message` (templated) of a person, and
// the reply becomes this step's output. `assigneeUserId` routes the
// needs-input notification; unset means the run's owner is asked.
const humanReviewNode = z.object({
  id: z.string(),
  type: z.literal('humanReview'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    message: z.string(),
    assigneeUserId: z.string().optional(),
    disabled: z.boolean().optional(),
  }),
})

// Return an explicit HTTP response to an inbound webhook caller. The runtime
// records this independently from the flow's normal output so later cleanup
// steps may continue without changing what the caller receives.
const respondWebhookNode = z.object({
  id: z.string(),
  type: z.literal('respondWebhook'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    statusCode: z.number().int().min(100).max(599).default(200),
    headers: z.string().optional(),
    body: z.string().optional(),
    bodyMode: z.enum(['json', 'text', 'binary', 'none']).default('json'),
    disabled: z.boolean().optional(),
  }),
})

// Durable delay. Short waits sleep inline; long waits pause the run with a
// wakeAt marker so cron/worker dispatch can resume it without holding a worker.
const waitNode = z.object({
  id: z.string(),
  type: z.literal('wait'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    amount: z.number().min(0).default(1),
    unit: z.enum(['seconds', 'minutes', 'hours', 'days']).default('seconds'),
    // 'webhook': instead of a timed delay, park the run until an external
    // POST hits /api/flows/<id>/runs/<runId>/resume (flow webhook secret
    // auth); the callback body becomes this step's output.
    until: z.enum(['delay', 'webhook']).optional(),
    disabled: z.boolean().optional(),
  }),
})

// Repeat a flat body until its condition succeeds, with hard caps preventing
// accidental infinite polling loops.
const repeatUntilNode = z.object({
  id: z.string(),
  type: z.literal('repeatUntil'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    body: z.array(z.string()).default([]),
    clauses: z.array(conditionClauseSchema).default([]),
    match: z.enum(['all', 'any']).optional(),
    maxIterations: z.number().int().min(1).max(1000).default(20),
    delayMs: z.number().int().min(0).max(60000).optional(),
    disabled: z.boolean().optional(),
  }),
})

// First-class INPUT: the flow's typed, named parameter list — its callable
// signature. Values resolve with precedence user > webhook > default and are
// coerced at the boundary, then exposed as {{input.<name>}}. A flow WITHOUT an
// input node keeps today's opaque {{trigger.input}} semantics (back-compat).
const inputNode = z.object({
  id: z.string(),
  type: z.literal('input'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    params: z.array(inputParamSchema).default([]),
    disabled: z.boolean().optional(),
  }),
})
// First-class OUTPUT: the flow's typed return object. Each field is bound from
// context by a templated `value` and coerced to `type`. A flow WITHOUT an output
// node returns today's implicit lastOutput (back-compat).
const outputNode = z.object({
  id: z.string(),
  type: z.literal('output'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    fields: z.array(outputFieldBindingSchema).default([]),
    disabled: z.boolean().optional(),
  }),
})
// Synchronous SUBFLOW: run a child flow to completion and block on its output.
// `input` is a JSON object string mapping the child's input params to templated
// values (same shape as a tool node's args). The step output is the child's
// output-node object.
const subflowNode = z.object({
  id: z.string(),
  type: z.literal('subflow'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    flowId: z.string(),
    input: z.string().optional(),
    onError: z.enum(['stop', 'continue']).optional(),
    outputFields: z.array(outputFieldSchema).optional(),
    disabled: z.boolean().optional(),
  }),
})

// AI ROUTER: an LLM picks one labelled branch from the resolved input + each
// branch's description. Routed on the MAIN CHAIN by edge branch = chosen id
// (like switch), with a `default` edge fallback. The pick is delegated to an
// injected adapter (RouteAiFn) so the interpreter stays pure; on resume the
// interpreter reuses the branch chosen on the first run (determinism).
const routerNode = z.object({
  id: z.string(),
  type: z.literal('router'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    input: z.string().optional(),
    instructions: z.string().optional(),
    branches: z.array(z.object({ id: z.string(), label: z.string().optional(), description: z.string().optional() })).default([]),
    disabled: z.boolean().optional(),
  }),
})
// ERROR SHIELD: a container that runs `body`; if the body FAILS, it runs
// `fallback` instead and shields the error (the step succeeds with the
// fallback's output). pause/stop/drop are NOT shielded (they propagate). The
// caught error is exposed to the fallback via {{error}}.
const errorShieldNode = z.object({
  id: z.string(),
  type: z.literal('errorShield'),
  data: z.object({
    label: z.string().optional(),
    note: z.string().optional(),
    body: z.array(z.string()).default([]),
    fallback: z.array(z.string()).default([]),
    disabled: z.boolean().optional(),
  }),
})

export const flowNodeSchema = z.discriminatedUnion('type', [
  triggerNode, agentNode, conditionNode, loopNode, parallelNode, stopNode, toolNode, httpNode, codeNode, transformNode, filterNode, switchNode, variableNode, dataNode, humanReviewNode, respondWebhookNode, waitNode, repeatUntilNode, inputNode, outputNode, subflowNode, routerNode, errorShieldNode,
])
export const flowEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  // 'true'/'false' for a condition; a switch case id or 'default' for a switch.
  branch: z.string().optional(),
})
/**
 * Free-form canvas node positions, keyed by node id. Layout is a VIEW concern,
 * not node data — keeping it in one map (rather than on all 22 node variants)
 * leaves the node union clean and makes the field trivially optional. A graph
 * without a layout (every flow authored before the DAG canvas) is auto-laid-out
 * on open via `autoLayout` — nothing is stored until the user moves something.
 */
export const flowLayoutSchema = z.record(z.string(), z.object({ x: z.number(), y: z.number() }))

export const flowGraphSchema = z.object({
  nodes: z.array(flowNodeSchema),
  edges: z.array(flowEdgeSchema),
  layout: flowLayoutSchema.optional(),
})

export type FlowNode = z.infer<typeof flowNodeSchema>
export type FlowEdge = z.infer<typeof flowEdgeSchema>
export type FlowGraph = z.infer<typeof flowGraphSchema>
export type FlowLayout = z.infer<typeof flowLayoutSchema>
export type NodePosition = { x: number; y: number }
export type ConditionClause = z.infer<typeof conditionClauseSchema>

/** A fresh graph: one manual trigger, no steps yet. */
export function emptyGraph(): FlowGraph {
  return { nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } }], edges: [] }
}
