# n8n import parity — round 2 gap closure

**Date:** 2026-08-07
**Branch:** feat/flow-import
**Status:** Approved direction ("close the remaining gaps"); this spec consolidates the round-2 audit findings and the remaining round-1 items into one execution scope.

## Problem

The credential mapping table closed round 1's top gap, but imports still degrade in five ways users hit constantly: computed expressions arrive as dead literal text, the most common legacy nodes (itemLists, v1 If/Filter, v1–v2 Switch) import empty or as stubs, ten integrations stub despite native tools existing, popular programmatic-auth credentials (Notion, OpenAI) refuse prefill unnecessarily, and n8n polling triggers demote to manual despite Sublime now having poll triggers.

## Scope (ranked; each lands independently with tests)

### 1. Computed-expression translation via `{{js:}}`

Today only 4 reference forms translate; everything computed is kept verbatim (warned) or extracted to a code step (≤4 fields, whitelist). The runtime now evaluates `{{js: <expr>}}` in QuickJS with scope `$json`, `item`, `step` (by node id), `input`, `trigger`, `vars`, `loop` (`execute-flow.ts:735-750`).

New tier between "simple path" and "keep verbatim": a `{{ … }}` segment that fails the simple-path regexes becomes a `{{js: …}}` token after reference rewriting:

- `$json` → the SAME target tier-1 uses (`step["<predId>"]` for a single main predecessor, `trigger.input` when the predecessor is the trigger, `item` on forEachItem steps). Requires exactly one main predecessor — same rule as tier-1.
- `$node["Name"].json` and `$('Name').item.json` / `.first().json` / `.last().json` → `step["<id>"]` via the existing `idByName`.
- `$env.NAME` → `vars.NAME` (the importer already materializes variable steps for `$env`).
- `$now` / `$today` → an inline IIFE prelude defining them as the existing `__dateShim` object (reuse `EXPR_PRELUDE`'s shape from the code-step extractor).
- Deny-list keeps the segment verbatim + warning (all-or-nothing per STRING still applies): `$items`, `$runIndex`, `$itemMatching`, `$binary`, `$execution`, `$workflow`, `$prevNode`, `$fromAI`, and n8n extension methods with no JS equivalent (`.toDateTime(`, `.removeTags(`, `.extractEmail(`, `.extractDomain(`, `.beginningOf(`, `.endOfMonth(`, `.plus(`, `.minus(`, `.format(`).

Mixed text stays supported — each `{{ }}` segment maps to its own token in the same string. The existing code-step extraction path remains for fields it already handles (it produces better previews); the js: tier catches what extraction declines. Existing tier-1 paths are untouched (no QuickJS cost for plain references).

### 2. `itemLists` node mapping

Route `itemLists` operations onto the existing `dataNodeCode` generators: `splitOutItems`→splitOut, `aggregateItems`→aggregate, `removeDuplicates`→removeDuplicates, `sort`→sort, `limit`→limit. Parameter names differ from the modern nodes (e.g. `fieldToSplitOut`, `fieldsToAggregate.fieldToAggregate[].fieldToAggregate`) — map them per operation. `concatenateItems`/`summarize` → stub with a specific warning.

### 3. Legacy condition shapes

- `clausesFrom` gains the v1 If/Filter shape: `conditions.{boolean,number,string,dateTime}[]` buckets of `{value1, operation, value2}`; map operations (equal, notEqual, larger, largerEqual, smaller, smallerEqual, contains, notContains, startsWith, endsWith, regex, isEmpty, isNotEmpty, true/false) onto `CONDITION_OPS` where an equivalent exists; unmappable → `complete:false` (existing warning path).
- `switch` v1/v2: when `rules.values` is absent, read `rules.rules[]` (`{operation, value2}` + node-level `dataType` + `value1`), one case per rule in output-index order; honor numeric `fallbackOutput` the same way the v3 path does.

### 4. Delivery-tool wiring for 10 integrations

Same pattern as the existing slack/gmail/sheets/salesforce arms, one arm per n8n node, mapping ONLY the operations whose delivery tool exists (everything else falls to `stub()` with the specific-operation warning): `github` create-issue → `github_create_issue`; `asana` create-task → `asana_create_task`; `googleCalendar` create-event / getAll-events → `calendar_create_event` / `calendar_list_events`; `googleDrive` upload / download / list → `drive_upload_file` / `drive_download_file` / `drive_list_files`; `clickUp` create-task → `clickup_create_task`; `confluence` create-page → `confluence_create_page`; `mondayCom` create-item → `monday_create_item`; `intercom` search/getAll contacts → `intercom_search_contacts`; `perplexity` search → `perplexity_search`. Argument mapping per tool follows each DELIVERY_TOOLS input schema (`src/lib/nango/delivery.ts`).

### 5. Programmatic-credential overrides

A small hand-curated override map consulted BEFORE the generated table, for n8n credentials that classify `unsupported` only because their nodes inject auth in node code while the API itself is plain header auth: `notionApi`→bearer, `openAiApi`→bearer, `seaTableApi`→bearer, `telegramApi`→unsupported stays (token-in-URL — genuinely unrepresentable), `airtableApi`→apiKeyQuery? — verify each against the vendor API docs comment-by-comment; only include ones with a certain answer (bearer/queryParam known). Lives in code (`n8n-credential-overrides.ts`) with a one-line WHY per entry, merged at lookup time so regeneration never clobbers it.

### 6. Poll-trigger conversion

`googleSheetsTrigger` / `googleCalendarTrigger` / `googleDriveTrigger` → `{type:'poll', source:{connectionId:'nango:<cap>', toolName:<read tool>}, intervalMinutes}` (from the node's `pollTimes` when present, else default; clamp to POLL_MIN). Other polling triggers keep the manual fallback + a sharper warning naming the trigger type.

## Explicit non-goals (this round)

- Export-direction fidelity (branch indices, real if/switch/set params) — separate spec; import is where users bleed today.
- `compareDatasets`, `executeCommand`, binary-file nodes — no runtime equivalent; stubs stay.
- Full n8n expression-extension library emulation — the deny-list keeps those honest.

## Testing

Per scope item: unit tests in the existing suites (`n8n-import.test.ts` for node arms/triggers/credentials, dedicated test blocks for the expression tier). The fuzz suite (`n8n-fuzz.test.ts`) must stay green — it guards converter crash-safety over malformed inputs. Full `npm test` before each commit.
