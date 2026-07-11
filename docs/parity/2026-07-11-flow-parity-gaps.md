# Flow Parity Gap Report — vs Power Automate & Workato

**Date:** 2026-07-11 · **Inputs:** full codebase inventory + Power Automate (2025-26 new designer) + Workato (2025-26 recipes) research
**Context:** produced after landing the four parity fixes (canvas drag-to-scroll, `CONDITION_IN_CONTAINER` publish+runtime guard, canonical trigger naming/icons, trigger-level filter).

## Where we already have parity (no action)

Nested loop/parallel containers · per-step retry/backoff/timeout · container error propagation · pause/resume with atomic claim + snapshot pinning + approval correlation · full HTTP action (SSRF-guarded, OAuth-injected) · all 7 Data Operations (compose/parseJson/join/csvTable/htmlTable/filterArray/select ≈ PA's set) · typed variables (6 types/6 ops ≈ PA) · cron + calendar schedules · secret-verified webhook trigger · signal chaining with depth cap · trigger input fields + input memory · draft/publish versioning with restore (≈ PA solution flows) · undo/redo + cross-flow copy/paste · audit with hashed args · budget caps + reaper.

**Two deliberate design divergences (not gaps):** our trigger filter records a visible *skipped* run (PA suppresses the run entirely — better for billing noise, worse for observability); our condition/switch-in-body is now an explicit error where PA supports full nesting (see P2-9).

---

## Ranked gaps

### P0 — Foundations (internally known, block reliability at scale)

1. **Queue durability not wired.** The BullMQ `FLOW_EXECUTION` queue + dead-letter exist but no route calls them — every run executes inline (`execute-flow.ts:588`, "WS-R2 Task 2"). A web dyno restart mid-run kills the run. *Effort: S (wiring) · Impact: high.*
2. **Loop resume re-runs prior iterations** (WS-R2 "resume-from-cursor"). Pause on item N → resume restarts at item 0, re-firing earlier side effects — duplicate-delivery risk. Both competitors avoid mid-run replays (Workato reruns whole jobs but *warns*; PA resumes precisely). *Effort: L · Impact: high (safety).*

### P1 — Highest-value capability gaps (CORE in both competitors)

3. **Formula/expression language.** [BOTH CORE] PA: ~140 WDL functions usable in any field; Workato: allowlisted-Ruby formula mode with type-aware editor. Ours is pure `{{token}}` substitution — zero functions, so every trivial concat/date-add/uppercase burns an *agent step* (LLM cost + latency + nondeterminism). The single deepest moat. Start small: a `{{ expr | fn }}` or `fn(token)` grammar over ~20 functions (concat, split, upper/lower, trim, add/sub, formatDate, now, coalesce, length, if). *Effort: L · Impact: very high.*
4. **Try/catch scope.** [BOTH CORE] PA: scope + run-after (failed/timed-out); Workato: monitor block + error branch with bounded auto-retry. Ours: only per-step `onError: stop|continue` — no compensating actions, no error branch, no `result()` introspection. A `tryCatch` container (try body + catch body receiving `{{error}}`) fits the existing flat-body container model. *Effort: M · Impact: high.*
5. **Do-until / repeat-while loop.** [BOTH CORE — and newly surfaced by this sweep; not on the prior deferred list] PA: do-until with iteration+timeout caps; Workato: repeat-while. Ours: only for-each. A `while` container reusing the condition-clause UI + `maxLoopIterations` cap is a small addition to the interpreter's container family. *Effort: S-M · Impact: medium-high (polling/retry-until-done patterns are common).*
6. **Run resubmit from history.** [BOTH CORE] PA: resubmit any run from history; Workato: rerun with the cached trigger event (+ duplicate-risk warning). Ours: "input memory" prefills the *next manual test* only — no per-run resubmit button on a failed run. Cheap because trigger payloads are already persisted on `FlowRun`. *Effort: S · Impact: medium-high (operator workflow).*

### P2 — Structural bets (schedule deliberately)

7. **Callable sub-flows.** [BOTH CORE] PA child flows (sync, typed response); Workato recipe functions (sync + async + join). Ours: only one-way async signals (`flow.completed`). Needs a `callFlow` node, input/output contract, depth cap, and reentrancy guard. *Effort: L · Impact: high for teams composing flows.*
8. **Polling triggers with cursor.** [BOTH CORE] Connector-driven "new/changed record" triggers with durable cursors + dedup. Ours: none (webhook/schedule/signal/manual only). Natural design: scheduled poll + MCP tool call + cursor persisted on the flow + dedup by record id. *Effort: L · Impact: high (most SaaS sources lack webhooks).*
9. **Branching inside container bodies.** PA nests conditions/switches 8 levels deep inside loops; we now *explicitly block* it (correct for the flat-list body model). True parity needs nested branch sub-bodies in the graph model + builder UI. The Filter step + P1-4 tryCatch cover the common cases meanwhile. *Effort: XL · Impact: medium (workarounds exist).*
10. **Cross-run shared state.** Workato: lookup tables + Data Tables + environment/project properties [CORE for them]; PA leans on Dataverse. Ours: none — state lives only in run-scoped variables. A minimal org-scoped key/value "lookup table" (CRUD UI + `{{lookup.table.key}}` root + a data-op) unlocks routing tables and config-driven flows. *Effort: M · Impact: medium-high.*

### P3 — Builder & testing polish

11. **Copilot diff-preview.** Workato previews proposed changes highlighted in the editor before applying [CORE for them]; notably PA's in-designer copilot edits apply directly too (undo is the safety net) — so we match PA, trail Workato. Given our copilot already returns structured ops, rendering an accept/reject preview of op summaries is tractable. *Effort: M · Impact: medium (user-requested).*
12. **Mocked testing.** PA static results (mock an action's output, disable-without-delete); Workato test automation suites (mock trigger/action data + assertions). Ours: live test runs only. Per-step "static result" toggle is the cheaper half. *Effort: M · Impact: medium.*
13. **Long-flow navigation.** PA new designer: minimap + fit-view + in-flow operation search. We now have drag-to-scroll + zoom + step search (rail); no minimap/fit-to-content-width. *Effort: S · Impact: low-medium.*
14. **Multi-select.** De-prioritized by the sweep: PA *cloud* flows have no true multi-select either (containers are the workaround); only desktop flows do. Trailing no one that matters. *Effort: M · Impact: low.*
15. **Split-on / batch triggers.** PA debatching (one run per array item), Workato batch triggers [NICHE-to-CORE for high volume]. Ours: a webhook array payload is one run; the loop node handles fan-out in-run. *Effort: M · Impact: low until volume demands it.*

---

## Suggested sequencing

Given the stated pivot to Graph RAG + agent responses next, the parity work that most protects that investment: **P0-1 (queue wiring)** and **P1-6 (resubmit)** are small and operational; **P1-3 (expressions)** is the one big bet worth scheduling as its own effort because it removes LLM cost from every deterministic flow; everything else can trail behind the RAG work.

*Deduped against the previously-known deferred list: formula mode (#3), try-catch (#4), callable sub-flows (#7), polling triggers (#8), lookup tables (#10), copilot diff-preview (#11), multi-select (#14), resume-from-cursor (#2), 2D canvas (superseded by drag-to-scroll — dropped). New finds this sweep: do-until/repeat-while (#5), run resubmit (#6), mocked testing (#12), minimap (#13), split-on (#15), and the PA-doesn't-have-multi-select-either de-prioritization.*
