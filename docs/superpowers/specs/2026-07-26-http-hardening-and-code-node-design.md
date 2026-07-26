# HTTP hardening + Code node — design

Date: 2026-07-26 · Branch: feat/goals · Approved by James in-session.

## Goals

1. **Harden the HTTP node** against the five risks named in review: every method
   actually callable; header/body/query field editors faithful; entered data
   surviving the save path; credentials testable before they attach to a node;
   raw input/output visible in the NDV.
2. **Add a Code node** (JavaScript + Python) at n8n parity: Mode
   (Run Once for All Items / Run Once for Each Item), Language select, default
   snippets, hint box, executed in the same three-pane NDV.

## Workstream 1 — HTTP hardening

All verifications are written as failing-test-first probes against the real
pipeline (`prepareHttpRequest` → `performHttpRequest`, mock fetch), not by
reading code:

| Ask | Probe |
|---|---|
| All methods callable | Per-method E2E: method reaches the wire; bodies ride on POST/PUT/PATCH/DELETE/OPTIONS; HEAD's empty response parses |
| Field editors correct | `Using Fields Below` (InlineKeyValue) and `Using JSON` produce identical requests; `{{tokens}}` survive the row round-trip |
| Data actually saved | A fully-loaded NDV config parses through the zod `httpNode` schema unchanged — zod strips unknown keys, so any UI-only field would be silently lost on save; the test makes that class of bug impossible |
| Credentials tested pre-attach | Regression test: a credential that fails verification never reaches `node.data.credentialId` without an explicit “Attach anyway” |
| Raw input/output | Render tests pinning the NDV's raw panes |

Anything a probe surfaces is fixed in the same pass, test-first.

## Workstream 2 — Code node

### Execution engine (decided)

- **JavaScript**: `node:vm`. Code wrapped in an async IIFE, minimal frozen
  context, `console.log` captured to a `logs` array, timeout via race
  (default 10s, clamped to 60s). NOT a hard security boundary — the same
  caveat n8n ships; Sublime's code authors are org members, as in n8n
  self-hosted.
- **Python**: `pyodide` (CPython → WASM). Lazy module-level singleton: loads
  once per process — warm in the BullMQ worker, ~seconds cold on the
  serverless test-node route. Fresh globals per run so state cannot bleed
  between steps or tenants. WASM-isolated. Known limit: a timeout rejects the
  await but the interpreter run completes in background.

### Semantics

- The node's input is its upstream output. An array is the item list; a
  single value is one item. `allItems` runs the code once with the full list;
  `eachItem` runs it per item and collects the returns.
- JS exposes `$input.all()` / `$input.first()` / `$input.item` plus plain
  `items` / `item`. Python exposes `_items` / `_item`. Return value is the
  step output and must be JSON-serializable (enforced by round-trip).

### Shape

- Schema: `code` node — `{ label?, note?, language: 'javascript'|'python',
  mode: 'allItems'|'eachItem', code, onError?, retries?, timeoutMs?,
  disabled?, mockOutput?, excludeFromContext?, outputFields? }`.
- `interpret.ts` stays pure: dispatch via injected `opts.runCode`
  (the `runAgent` pattern), wired in `execute-flow.ts` and the test-node
  route to `src/lib/code/run-js.ts` / `run-python.ts`.
- UI: `code-body.tsx` — Mode select, Language select, monospace editor
  seeded with n8n's default snippets (swapped on language/mode change only
  while the code is still an untouched default), n8n's hint text. Standard
  advanced params (onError/retries/timeout/disabled/mockOutput).
- Palette label: **Code**. Validation: code must be non-empty.

### Dependencies

`pyodide` (npm) added to dependencies.

## Testing

TDD throughout: runner unit tests (sync/async/return/throw/timeout/log
capture/state isolation), interpreter dispatch tests with a fake runner, UI
component tests through the NDV harness, plus the WS1 probe suite. Gates:
typecheck, lint, full `npm test`, production build.
