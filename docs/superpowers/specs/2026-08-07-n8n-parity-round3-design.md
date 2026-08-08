# n8n parity — round 3: export fidelity, big-four depth, item pairing

**Date:** 2026-08-07 (late)
**Branch:** feat/flow-import
**Status:** Approved direction ("close these remaining gaps").

## A. Export fidelity (`src/lib/export/n8n.ts`)

Today every edge collapses into n8n output index 0 and if/switch/set/stop/respondWebhook export `{}` params. Round 3 makes a Sublime flow with branches and conditions round-trip.

**A1. Branch → output index.** `condition`: `branch:'true'`→0, `'false'`→1. `switch`: case order index; a `default` edge → the extra fallback output (`fallbackOutput:'extra'`, index = cases.length). All other node types keep index 0.

**A2. Reverse expression translation** (new helper `toN8nExpression`, the import tier run backwards): `{{trigger.input.x}}`→`={{ $json.x }}`, `{{item.x}}`→`={{ $json.x }}`, `{{step.<id>.output.x}}`→`={{ $node["<label>"].json.x }}` (label from the exported node's name, already uniquified), `{{var.X}}`→`={{ $env.X }}`, `{{js: expr}}`→`={{ expr }}` with the scope rewrites reversed (`step["id"]`→`$node["label"].json`, `trigger.input`→`$json`, `item`→`$json`, `vars.`→`$env.`). Mixed text keeps surrounding literals. Strings with no tokens export unchanged (no `=` prefix).

**A3. Real params.**
- `condition`/`filter` → if v2: `{conditions: {combinator: match==='any'?'or':'and', conditions: [{leftValue, rightValue, operator:{type:'string'|'number', operation}}]}}` — ops reverse via the inverse of OP_MAP (`eq`→`equals`, `gt`→`larger`, `contains`→`contains`, `matches`→`regex`, …); numeric operator type when both sides look numeric, else string.
- `switch` → v3.4 `rules.values[{outputKey, conditions}]` + `looseTypeValidation`, `fallbackOutput` `'extra'` only when a default edge exists.
- `transform` → set v3.4 `assignments.assignments[{id,name,value,type:'string'}]`; `data` op `compose`/`parseJson` → set `mode:'raw'` with `jsonOutput`; other data ops keep noOp+note (their semantics live in generated code on import — no honest n8n param shape).
- `stop` → `stopAndError` v1 `{message}`.
- `respondWebhook` → `respondToWebhook` v1.1 `{respondWith:'json'|'text'|'noData', responseBody, options:{responseCode}}`.
- `http` → add `sendHeaders/headerParameters`, `sendQuery/queryParameters`, `sendBody` + `contentType`, translated via A2.

Non-goals: containers (loop/parallel/errorShield bodies stay flattened with notes), router (AI-routed — no n8n equivalent), tool steps (stay noOp+note naming the integration/action).

## B. Big-four operation depth

New delivery tools (Nango proxy JSON calls, same pattern as existing runners) + importer arms routing the matching n8n resource/operation onto them:

| Tool | Endpoint | n8n op routed |
|---|---|---|
| `slack_update_message` | POST `/chat.update` {channel, ts, text} | message.update |
| `slack_get_channel_history` | GET `/conversations.history` {channel, limit} | channel.history |
| `slack_add_reaction` | POST `/reactions.add` {channel, timestamp, name} | reaction.add |
| `gmail_get_message` | GET `/gmail/v1/users/me/messages/{id}` | message.get |
| `gmail_list_messages` | GET `/gmail/v1/users/me/messages?q=` | message.getAll |
| `gmail_trash_message` | POST `…/messages/{id}/trash` | message.trash |
| `sheets_clear_values` | POST `/v4/spreadsheets/{id}/values/{range}:clear` | sheet.clear |
| `salesforce_update_record` | PATCH `/services/data/v60.0/sobjects/{type}/{id}` | <resource>.update |
| `salesforce_get_record` | GET `…/sobjects/{type}/{id}` | <resource>.get |
| `salesforce_query` | GET `/services/data/v60.0/query?q=` | search.query |

Salesforce update/get/create arms accept any of its record resources (lead, contact, account, opportunity, case, task — the sobject name derives from the n8n resource). Tests: delivery.test.ts pattern (injected proxy asserting method/endpoint/data), importer tests per arm.

## C. Item pairing (sound subset only)

- `$itemMatching(i)` → `items[i]` in the JS code shim (`withN8nCodeShim`) — n8n's default pairing IS index-based for linear chains, so this is a faithful approximation for the common case; a comment in the shim states the limit (explicit multi-source pairing is not tracked).
- `.item` on `$input` already exists in the shim; `pairedItem` metadata and cross-node `$items("Name")` stay out (no cross-step access in code steps).
- **Binary passthrough stays a documented non-goal**: emulating n8n binary items needs a run-engine binary store (upload/download buffers between steps); a converter cannot fake it honestly. Imports referencing `$binary` keep the existing verbatim-plus-warning path.

## Testing

Export: new round-trip tests — export a branched flow, re-import it, assert branches and conditions survive (`export/n8n.ts` output fed to `fromN8nWorkflow`). Delivery: proxy-injection unit tests per new tool. Import arms: n8n-import.test.ts. Full `npm test` gates each commit.
