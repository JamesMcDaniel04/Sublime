# Behavioral Intelligence — Design Spec (DRAFT)

**Date:** 2026-07-11 · **Goal:** the platform learns how each org actually operates from the tools they connect, and converts that understanding into org-specific, repeatable automations — making every subsequent request smoother.

## The loop (user's framing, mapped to architecture)

```
connect tool ──► USAGE SCAN ──► org usage profile (graph insights + shared memory)
                                        │
assistant/agent request ──► pull sources (RAG: profile + graph + knowledge + memory)
                                        │
                              fulfill the request
                                        │
                    TEMPLATE-FROM-RUN (reusable flow/agent template)
                                        │
                    COMMIT learnings to shared memory + graph
                                        │
                    next request starts warmer ◄──────────┘
```

## What already exists (reused, not rebuilt)

- **Tool planes** (`tool-planes.ts`) — can list + call any connection's tools (Klavis, Nango, custom MCP) with org scoping.
- **Graph store** — `insight` node type + org-shared visibility; incremental indexing; retrieval already feeds agent prompts (with budget + citations).
- **Shared agent memory** — `saveAgentMemory` kinds `learning`/`suggestion` with embedding dedupe (≥0.86) and caps; already retrieved into every run.
- **Reflection** (`reflectAndRemember`) — post-run LLM distillation into learnings/critique/suggestions.
- **Flow copilot** (`copilot-ops`, `repairGeneratedFlowGraph`) — LLM → validated flow graph.
- **Templates** — community template CRUD (`/api/agent-templates`).

## Phase 1 — Connection Usage Scan

**Trigger:** a new connection becomes active (Klavis instance created; Nango connection linked; custom MCP connection authorized).

**Scanner** (`src/lib/intelligence/connection-scan.ts`):
1. Load the connection's tool list via the existing plane loaders.
2. Select up to **6 read-only tools** by allowlist heuristic (`list_*`, `get_*`, `search_*`, `recent*` — never anything matching write verbs) and call each once with minimal/default args, bounded (timeout 15s, response truncated to ~8k chars each). Read-only by construction.
3. One LLM pass (cheap tier) over the samples → a **usage profile**: what the org tracks in this tool, naming conventions, cadence signals, key entities, apparent processes. Structured output: `{ summary, entities[], processes[], automationCandidates[] }`.
4. Persist: an `insight` graph node per tool (`insight:scan:<connectionId>`, org-shared, embedded) + one `learning` memory per distinct process (`saveAgentMemory` dedupes re-scans).
5. Activity/notification: "Scanned GitHub — learned 3 processes" so learning is visible, never silent.

**Consent + safety:** scans are read-only samples, org-scoped, capped; runs automatically on connect with an org-level toggle to disable (and a "Rescan" action). No raw records persist — only the distilled profile text.

## Phase 2 — Workflow Suggestions

After each scan (and weekly), a synthesis pass over the org's accumulated profiles + recent run history proposes **org-specific automations**: LLM outputs suggestion candidates ("Weekly GitHub issue triage digest to Slack"), each saved as a `suggestion` memory (deduped) **plus a ready-to-open draft flow graph** generated via the existing copilot path and stored as a flow in `DRAFT` status tagged `suggested`. Surface: a "Suggested for you" rail on /flows and /templates with accept (keeps flow) / dismiss (marks memory dismissed — dedupe stops re-suggesting).

## Phase 3 — Template-from-Run + memory commit

After a successful agent/assistant run (already reflected into memory), extend reflection with a **replayability judgment**: "would this run make a reusable automation?" If yes (and structurally sound — tools used, inputs identifiable), generate a template: agent-template row (or draft flow when the run was multi-step tool orchestration) named from the run headline, tagged `auto-generated`, linked to the source run. Dedupe by embedding against existing auto-templates. The user sees "Save as template?" on the run (accept/dismiss), or auto-save with visible attribution — decision below.

## Decisions needed

1. **Scan consent:** auto-scan on connect (with org toggle + visible activity) vs explicit "Scan now" button per connection. *Recommend auto + toggle: frictionless is the stated goal; scans are read-only and distilled-only.*
2. **Template-from-run:** auto-create drafts (visible, deletable) vs prompt-per-run ("Save as template?"). *Recommend auto-create drafts tagged `auto-generated`, capped (e.g. 20 open drafts/org, oldest evicted) — friction-free with easy cleanup.*

## Out of scope (this effort)

Cross-org learning; fine-tuning; scanning message *content* archives at depth (samples only); autonomous flow publishing (suggestions always land as drafts a human activates).
