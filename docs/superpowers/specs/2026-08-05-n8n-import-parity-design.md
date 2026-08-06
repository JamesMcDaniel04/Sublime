# n8n Import Parity — AI-agent cluster + runnable conversion

**Date:** 2026-08-05 (addendum to `2026-08-05-flow-import-design.md`)
**Status:** Approved (all three tiers)
**Branch:** `feat/flow-import`

## Problem

Imported n8n workflows don't run the way they do when re-imported into n8n.
The biggest gap: n8n's AI Agent is a *cluster* — the agent node plus separate
model/tool/memory sub-nodes wired via non-`main` connection types
(`ai_languageModel`, `ai_tool`, `ai_memory`, …, keyed by the **sub-node's**
name pointing into the agent). Our converter only reads `main`, so the cluster
shatters: models/memory become bogus agent steps, tools become dangling HTTP
stubs, and the agent loses its instructions (`parameters.options.systemMessage`),
model, and tools.

Source-verified facts driving this design are in the n8n mapping report
(connection enum `interfaces.ts:2789`, agent params `AgentV3.node.ts:55-137`,
`Tool`-suffix rule `cli/src/tool-generation/ai-tools.ts:33`, resourceLocator
collapse `node-helpers.ts:330`, splitInBatches outputs `['done','loop']`,
switch fallback semantics `SwitchV3.node.ts:415-476`).

## Tier 1 — AI cluster + correctness

**Cluster absorption** (`fromN8nWorkflow`):
- Parse every connection type. Build an attachment index from sub-node-keyed
  `ai_*` connections; absorbed sub-nodes never become graph nodes.
- `@n8n/n8n-nodes-langchain.agent` / `agentTool` / `chainLlm` → an `agent`
  step backed by a **materialized agent** (`agentsToCreate` — same machinery
  the portable import uses; ref = the n8n node id):
  - instructions ← `parameters.options.systemMessage` (agent) or system
    entries of `messages.messageValues` (chainLlm); fallback to
    `toolDescription`/name.
  - model ← attached `lmChat*` sub-node: `parameters.model` (string) or
    `parameters.model.value` (`__rl` resourceLocator) or `parameters.modelName`
    (Gemini). `claude-*` values pass through verbatim (our runtime runs them
    natively); anything else → omitted (falls back to DEFAULT_AGENT_MODEL) +
    warning naming the original model.
  - integrations ← attached tool sub-nodes with the `Tool` name suffix:
    `n8n-nodes-base.gmailTool` → `gmail`, `googleSheetsTool` → `google_sheets`
    (camelCase→snake_case after stripping the suffix).
  - Unmappable tools get precise warnings: `mcpClientTool` (includes its
    `endpointUrl`/`sseEndpoint` so the user can connect that MCP server),
    `toolHttpRequest`/`httpRequestTool`, `toolCode`, `toolWorkflow`,
    `agentTool`-as-subagent. Memory sub-nodes → one informational warning
    (Sublime agents bring their own memory).
  - step `input` ← `parameters.text`, except the n8n default
    `={{ $json.chatInput }}` (or empty with `promptType: 'auto'`) → `''`
    (upstream context flows via `includeUpstream`).
- Route change: after materializing agents, call `syncAgentConnectors`
  (mirrors provision route :470) so integrations become live AgentConnector
  rows — this was missing for portable imports too.

**Correctness fixes** (all source-verified):
- `splitInBatches`: output 0 = **done**, output 1 = **loop** (not two plain
  edges creating a bogus cycle). See Tier 2 for body surgery.
- Condition operators: `startsWith`/`endsWith`/`notStartsWith`/`notEndsWith` →
  `matches` with anchored regex; `regex`→`matches`; boolean `true`/`false` →
  `eq true/false`; `empty`/`notEmpty`/`exists`/`notExists` → `eq ''`/`neq ''`
  approximations; `after`/`before` (dateTime) → `gt`/`lt`; unmappable ops
  (`notContains`, `lengthGt`, …) keep the warning path.
- Node-level properties: `onError: continueRegularOutput|continueErrorOutput`
  → `onError: 'continue'` (+ warning for the error-output variant);
  `retryOnFail`+`maxTries` → `retries` (clamped 0–5); `waitBetweenTries` →
  `retryDelayMs` (http only); `disabled` → `data.disabled` where the schema
  has it; `notes` → `data.note`.
- `respondToWebhook`: `responseCode` lives at `options.responseCode`;
  `respondWith: text→bodyMode 'text'`, `json→'json'`, `noData→'none'`;
  `redirect`/`jwt`/`binary` → warning.
- `set`: `mode: 'raw'` → `data` node `{op:'parseJson', input: jsonOutput}`;
  legacy `fields.values` (<3.3) with `stringValue|numberValue|…` supported.
- `httpRequest`: keypair body (`bodyParameters.parameters`) → JSON body;
  `contentType: 'raw'` → `body` + `bodyMode: 'raw'`; `options.timeout` →
  `timeoutMs`; `options.redirect.redirect` → `followRedirects`/`maxRedirects`;
  `options.batching.batch` → `batch`; pagination
  `responseContainsNextURL`+`nextURL` → `pagination.mode 'nextUrl'`
  best-effort; `authentication: predefined/generic` → warning (secrets never
  travel).
- `stopAndError` `errorType: 'errorObject'` → reason from `errorObject`.
- `wait`: v1.1 default amount 5; `resume: specificTime|webhook|form` →
  warning + default wait.
- `scheduleTrigger` → runnable Sublime schedule:
  `cronExpression` → `{type:'cron', cron}` (6-field n8n cron: drop the
  optional seconds field); `days` interval 1 + triggerAtHour/Minute →
  `{type:'daily', time:'HH:MM'}`; other intervals → generated cron + the
  original preserved in a warning when lossy.

## Tier 2 — "most workflows" coverage

- **Pure-data nodes become generated JavaScript `code` nodes** (runnable, not
  stubs). The code-node guest exposes `items` (array) and returns the step
  output (run-js.ts:176-190):
  - `limit` → `items.slice` respecting `keep: firstItems|lastItems`
  - `sort` (`type:'simple'`) → multi-key comparator from `sortFieldsUi`
  - `splitOut` → flatten `fieldToSplitOut` (comma-separated list supported)
  - `aggregate` → `aggregateAllItemData` → `{data: items}` variant;
    `aggregateIndividualFields` → per-field arrays
  - `removeDuplicates` (`removeDuplicateInputItems`) → JSON-key dedupe over
    all/selected fields
  - `renameKeys` → basic `keys.key[{currentKey,newKey}]` renames
  - `sort type:'random'|'code'`, `removeDuplicates` history modes → stub +
    warning (stateful/code-injection paths don't translate).
- **Loop surgery**: for `splitInBatches`, walk the loop-output edge chain; if
  it returns to the loop node cleanly, the traversed node ids become
  `loop.data.body`, `over` gets `'{{step.<predecessor>.output}}'`, the cycle
  edges are removed, and done-output edges continue the main chain. Anything
  tangled falls back to today's empty-loop warning.
- **`formTrigger`** → manual trigger + a typed `input` node built from
  `formFields` (label → snake_case name, fieldType → our FIELD_TYPES map,
  requiredField → required). `chatTrigger` → manual + warning.

## Tier 3 — expression translation

Post-pass over the converted graph, using the main-edge predecessor map:
- A `{{ … }}` segment whose entire content is `$json` or `$json.<path>`
  rewrites to `{{step.<pred>.output<.path>}}` **when the node has exactly one
  main predecessor** (the trigger as predecessor → `{{trigger.input}}`).
- `$node["Name"].json.<path>` → `{{step.<idOf Name>.output.<path>}}`
  unconditionally (name resolves through the converter's name→id table).
- Leading `=` is stripped whenever every segment in the string translated;
  otherwise the string stays verbatim and the untranslated count feeds the
  existing summary warning.
- Complex segments (function calls, `$now`, ternaries) never partially
  translate — all-or-nothing per string.

## Testing

Fixture-driven, extending `n8n-import.test.ts`: a realistic AI workflow
(chatTrigger + agent + lmChatAnthropic(resourceLocator) + gmailTool +
googleSheetsTool + memoryBufferWindow + mcpClientTool + agent `onError`/
`retryOnFail`), chainLlm, a splitInBatches loop that round-trips into a body,
each generated-code node (assert the JS actually returns the right shape by
eval-ing it in the test with a sample `items`), schedule/cron mapping,
formTrigger → input node, expression translation cases (single-pred, trigger
pred, $node ref, untranslatable), and route-level: created agent rows carry
integrations + connector sync ran.

## Out of scope

Auto-creating MCP connections from `mcpClientTool` endpoints (auth can't
travel); executing n8n `code` nodes' Python in-line (Pyodide already covers
python code nodes); combine-mode `merge` semantics (append/rewire + warning
stands); binary/file pipelines.
