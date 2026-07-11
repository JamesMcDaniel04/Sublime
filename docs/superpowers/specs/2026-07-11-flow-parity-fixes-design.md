# Flow Parity Fixes — Design Spec

**Date:** 2026-07-11
**Status:** Approved (design), pending implementation plan
**Branch:** work continues on the Sublime trunk (`main`)

## Goal

Close the verified parity gaps in the flow builder before the Graph-RAG effort:

- **A. Canvas drag-to-scroll** — click-and-hold on empty canvas background pans (scrolls) the builder, Power-Automate-style feel within the existing vertical-column architecture.
- **B. Condition/Switch inside container bodies fails loudly** — today `interpret.ts` silently skips them (`execNode`, the `condition`/`switch` arm); becomes a publish-time validation error plus a runtime failure, both pointing to the Filter step.
- **C. Canonical trigger naming + icon split** — one display name per trigger everywhere; the webhook trigger stops sharing the HTTP action's identical green Globe in the picker.
- **D. Trigger-level filter** — optional condition clauses on the trigger config; a run whose trigger payload fails the filter short-circuits immediately as skipped.
- **E. Fresh parity-gap sweep** — after A–D land, a multi-angle audit vs Power Automate/Workato, reported as a ranked list (analysis task, no code).

Verified findings this corrects (from code inspection, 2026-07-11):

- The audit claim "canvas pan is shipped and CI-green" is **false** — no pan exists; the canvas is a vertically scrolling centered 760px column (`src/app/flows/[id]/page.tsx:967-976`), zoom is a CSS `scale` on an inner wrapper, and there are **zero** canvas-interaction tests.
- Bug #1 mechanism: container bodies are flat ordered id-lists (`execBody`); condition/switch have no edges to route on inside a body, so `execNode` returns `{kind:'skip'}` (`src/features/flows/interpret.ts:352-355`).
- Naming/icons: webhook trigger is named 3 ways — "When an HTTP request is received" (`src/lib/flows/builtin-catalog.ts:98`), "Webhook trigger" (`src/components/flows/flow-canvas.tsx:188`), "Webhook (external)" (`src/components/flows/step-drawer.tsx:1424`). In the picker, trigger and HTTP action are pixel-identical: lucide `Globe` + `bg-emerald-600` (`src/components/flows/flow-picker.tsx:53,69,112,119`). On the canvas they differ (trigger = blue `Zap` always, regardless of subtype; `step-card.tsx:69-101`).

## A. Canvas drag-to-scroll

**Where:** the scroll container div in `src/app/flows/[id]/page.tsx` (~line 967, `ref={canvasScrollRef}`, `overflow-y-auto`).

**Behavior:**
- `pointerdown` with `button === 0` on the background starts a potential drag. "Background" = the event target is NOT inside an interactive/step element: ignore when `(e.target as Element).closest('[data-node-id], button, a, input, textarea, select, [role="menu"], [role="dialog"]')` matches.
- Capture the pointer; track `startY` + `startScrollTop`. On `pointermove`, `scrollTop = startScrollTop - (clientY - startY)`.
- **3px threshold**: below it, the gesture is a click — existing click-to-deselect fires unchanged. Above it, mark the gesture as a drag and suppress the subsequent `click` (a `wasDragged` ref checked by the container's `onClick`).
- Cursors: container gets `cursor: grab` idle (on the background), `grabbing` while dragging (set on `document.body` during the drag like the existing assistant-resize handler at `page.tsx:76-101`).
- Pointer capture + `pointercancel`/`pointerup` cleanup; text selection disabled during drag (`userSelect: none` on body, mirrored from the resize handler).
- No conflict with node reordering: cards use HTML5 drag-and-drop (`draggable` + `dataTransfer`), which never emits these pointer events from the background, and the `closest('[data-node-id]')` guard excludes card surfaces anyway.

**Test:** component test in the existing harness (`src/components/flows/__tests__/` pattern): render the builder canvas region (or a minimal extraction of the handler), dispatch `pointerdown`/`pointermove`/`pointerup`, assert `scrollTop` changed and that a sub-threshold gesture still triggers deselect while a dragged gesture does not.

**Non-goal:** 2D XY panning / free node placement — explicitly deferred; requires the full canvas rework (nodes have no coordinates).

## B. Condition/Switch in container bodies → explicit error

**Layer 1 — publish/run validation** in `src/lib/flows/validate.ts` (`validateFlowGraph`): for every `loop` node's `data.body` and every `parallel` node's `data.branches` (flattened), if a referenced node has `type === 'condition'` or `'switch'`, push an error issue:

- `code: 'CONDITION_IN_CONTAINER'`
- `message: '<label> can't run inside a For each / Parallel body — branching isn't supported there. Use a Filter step to gate items instead.'`
- `nodeId`: the offending condition/switch node id.

**Layer 2 — runtime guard** in `src/features/flows/interpret.ts`: `execNode`'s condition/switch arm currently returns `{kind:'skip'}` unconditionally (it is only reached from container bodies — the main-chain walker handles routing before calling `execNode`). Change it to emit a `failed` step event and return `{kind:'fail', error: <same message>}` so pre-existing stored graphs fail loudly instead of silently mis-running.

*Design note:* the main walker at `interpret.ts:622-630` intercepts `condition`/`switch` before `execNode` is consulted, so the runtime guard cannot fire for legitimate main-chain conditions. This must be asserted by a unit test (main-chain condition still routes; body condition fails).

**Tests:** `validate` unit tests (condition in loop body → error; condition on main chain → ok; switch in parallel branch → error) + `interpret` unit tests (body condition → run fails with the message; main-chain condition unaffected).

## C. Canonical trigger naming + icon split

**Names** (single source of display truth stays per-surface, but strings unified):
- Webhook trigger → **"When an HTTP request is received"** in all three places: picker (already, `builtin-catalog.ts:98`), canvas title (`flow-canvas.tsx:188`, replaces "Webhook trigger"), drawer option (`step-drawer.tsx:1424`, replaces "Webhook (external)").
- Schedule trigger → **"Schedule"** everywhere (canvas currently says "Schedule trigger", `flow-canvas.tsx:187`).

**Icons:**
- Picker: `TRIGGER_ICON.webhook` → lucide **`Webhook`**; `TRIGGER_TONE.webhook` → `bg-blue-600 text-white` (`flow-picker.tsx:112,119`) — triggers adopt the canvas's blue trigger identity; the HTTP action keeps `Globe` + emerald.
- Canvas: trigger cards get subtype icons instead of always-Zap — `step-card.tsx` icon selection special-cases `node.type === 'trigger'` on the trigger subtype: `webhook → Webhook`, `schedule → Clock`, `signal → Radio`, `manual → Zap` (tone stays `bg-blue-600`).

**Tests:** none beyond compile — pure display strings/maps; the existing suite guards regressions elsewhere. Visual confirmation in the run-skill drive.

## D. Trigger-level filter

**Data model** (`src/lib/flows/graph.ts`): trigger node `data` gains optional `filter?: { mode: 'and' | 'or', clauses: ConditionClause[] }` reusing `conditionClauseSchema`. Absent/empty = no filtering (fully backward compatible; stored graphs unaffected).

**Runtime** (`src/features/flows/execute-flow.ts` + `interpret.ts`): at run start, if the trigger node carries non-empty `filter.clauses`, evaluate with the existing `evalCondition` (`src/features/flows/context.ts:133`) against the initial context (`{ trigger: { input } }`). On false: the run completes immediately — trigger step recorded as `skipped` with output `"Trigger filter did not match — run skipped."`, run status succeeded, no other nodes execute. (Evaluating post-run-creation keeps one uniform path for webhook/schedule/signal/manual triggers and leaves an auditable skipped run in history; pre-creation suppression is a later optimization.)

**Builder UI** (`src/components/flows/step-drawer.tsx`, trigger editor section ~1420+): an "Only run when…" clause editor on the trigger drawer, reusing the same clause-row UI the condition editor uses (left / op / right rows + AND/OR mode). Only shown for non-manual triggers.

**Tests:** interpret/execute unit tests — filter false → run succeeds with only a skipped trigger step; filter true → normal execution; no filter → unchanged.

## E. Fresh parity-gap sweep

After A–D land and are verified: dispatch parallel research/code-inspection agents to compare the flow feature surface against Power Automate and Workato (triggers, actions, expressions, error handling, composition, builder UX), dedupe against the known deferred list (formula mode, try-catch, callable sub-flows, polling triggers, lookup tables, copilot diff-preview, multi-select), and deliver a ranked gap report. Output: a markdown report in `docs/`, no code changes.

## Out of scope

- 2D canvas / XY node positions; resume-from-cursor (WS-R2); the deferred big bets above (they are the *output* of E, not work items here).

## Verification

`npm run typecheck && npm run lint && npm test` green; new unit tests for B and D; component test for A; manual drive of the builder (run skill): drag-pan feel, condition-in-body publish error, renamed triggers + icons, trigger filter skipping a run.
