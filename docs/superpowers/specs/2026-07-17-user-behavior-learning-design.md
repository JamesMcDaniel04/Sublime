# User Behavior Learning — Design Spec

**Date:** 2026-07-17 · **Goal:** the platform learns how each *user* actually works — their in-app behavior, tool usage, agent runs, and routines — and converts well-evidenced patterns into grounded assistant answers, better copilot output, and quiet, auditable suggestions (drafts the user activates). Extends the org-level system in `2026-07-11-behavioral-intelligence-design.md`, which learns from *connected tools*; this layer learns from *the user inside Sublime*.

## Guiding constraint: learn before prescribing

The system must never volunteer a suggestion it cannot cite evidence for. Concretely:

- A pattern is **eligible** for any downstream use only if it has **≥ 3 supporting occurrences spanning ≥ 7 days**, the user is **past a 7-day learning period** (measured from their first recorded event), and no similar pattern was previously dismissed by that user.
- Eligibility is enforced in **one pure function** (`isPatternEligible`) that every consumer goes through. Nothing may bypass it.
- At most **one un-actioned suggestion per user** exists at a time; new suggestions wait until the current one is accepted or dismissed. Synthesis runs at most weekly per user.
- Every surfaced suggestion renders a dated "why this exists" evidence trail citing the specific runs/events behind it.

## What already exists (reused, not rebuilt)

- `activity_events` ledger pattern (immutable, org+time indexed, `indexedAt` re-index gate) — structural template for the new ledger.
- GraphRAG store (`src/lib/rag/`): actor→activity→entity projection (`activityGraphParts`), `preceded_by` chains, per-node `private` visibility with `ownerUserId`, `retrieveContext`/`renderContext`.
- Evidence-constrained inference: `writeInference` (`src/lib/activity/insights.ts`) — patterns structurally require `evidence` edges.
- Suggestion synthesis: `suggest-workflows.ts` (org-level pass, accept/dismiss feedback, dedupe, draft-flow generation).
- Programmatic creation: `generateFlowGraph` (validated flow graphs) and `createAgentFromDraft`.
- Context budgeting: `src/lib/context/assemble.ts` (merge + dedupe under a char budget).
- Job infra: BullMQ worker, `/api/cron/dispatch`, `/api/cron/retention`; env-gated degradation when Neo4j/Voyage are absent (MemoryGraphStore fallback).
- Fire-and-forget capture idiom: `recordAudit` (`src/lib/audit.ts`).

## Component 1 — Behavior event ledger

New Prisma model `user_events` (`UserEvent`):

| field | notes |
|---|---|
| `id` | cuid |
| `organizationId`, `userId` | scoping; index `(organizationId, occurredAt)` and `(userId, occurredAt)` |
| `kind` | bounded enum-like string, see list below |
| `resourceType`, `resourceId` | e.g. `agent`/`flow`/`suggestion` + id |
| `context` | small Json: references only (e.g. chat message id, trigger), **never raw content** |
| `occurredAt` | event time |
| `indexedAt` | null until projected to graph; re-index sweeps key off this |

**Event kinds (v1, exhaustive):** `agent_run_manual`, `agent_created`, `agent_edited`, `flow_created`, `flow_edited`, `flow_published`, `flow_run_manual`, `copilot_prompt`, `assistant_prompt`, `suggestion_accepted`, `suggestion_dismissed`, `template_used`, `connection_added`.

Explicitly **not captured:** page views, clicks, navigation, raw prompt/message text (prompt events reference the existing chat-message row by id).

**Capture:** server-side helper `recordUserEvent(input)` in `src/lib/behavior/record-event.ts`, modeled on `recordAudit`: fire-and-forget, fully wrapped — a failure logs to Sentry and never affects the user's request. Called from the API routes that already handle each action (agents execute/CRUD, flows CRUD/publish/execute, copilot chat, assistant chat, suggestion accept/dismiss, template use, connection create). No client SDK, no new endpoints.

**Retention:** `user_events` added to the existing retention cron with a 180-day window (patterns and graph nodes distilled from events persist independently; the raw ledger ages out).

## Component 2 — Graph projection

`indexUserEvent` in `src/lib/rag/` projects each event with the established shape: `actor(user) -[performed]-> activity(user_event) -[on]-> entity(agent|flow|…)`, plus per-user `preceded_by` chains (these enable sequence/routine mining). Per-user activity and pattern nodes use `private` visibility + `ownerUserId`; entities (agents/flows) remain shared nodes so per-user behavior links into the org graph.

Projection runs on the existing worker via the `activity-backfill` queue idiom; a sweep re-indexes any rows with `indexedAt = null`, so the graph is always rebuildable from the ledger.

## Component 3 — Evidence-gated pattern inference

New job `inferUserPatterns` in `src/lib/intelligence/` alongside `infer-patterns.ts`, dispatched daily from `/api/cron/dispatch` for users with ≥ 1 new event since last run. It performs one structured LLM pass over the user's recent event ledger + graph neighborhood and emits candidate patterns via `writeInference` (evidence edges to the cited events are mandatory; a candidate without resolvable evidence is dropped).

**Pattern kinds mined (v1):** repeated manual sequences (agent A then flow B), temporal routines (same action, same weekday/time-of-day band), recurring copilot/assistant intents (clustered by the referenced messages' embeddings), friction signals (repeated failures/retries of the same agent or flow).

**Pattern node fields:** `kind`, `occurrenceCount`, `firstSeenAt`, `lastSeenAt`, `ownerUserId`, summary text, evidence edge per supporting event.

**The gate:** `isPatternEligible(pattern, user)` — pure function, constants in one place (`MIN_OCCURRENCES = 3`, `MIN_SPAN_DAYS = 7`, `LEARNING_PERIOD_DAYS = 7`), plus a dismissal-similarity check (embedding similarity ≥ 0.86 to a dismissed pattern → ineligible, reusing the memory-dedupe threshold). All consumers (synthesis, assistant context, copilot grounding, agent proposals) call this gate; no other eligibility logic exists anywhere.

## Component 4 — Per-user suggestion synthesis

Extend `suggest-workflows.ts` with a per-user pass (the org pass is untouched). Inputs: the user's eligible patterns, their existing agents/flows, and their prior accept/dismiss feedback. Outputs:

1. **New draft automations** — `generateFlowGraph` → `prisma.flow.create` as `DRAFT`, or `createAgentFromDraft`, with `metadata: { suggested: true, sourcePatternIds, evidence }`. Drafts only; activation is always the user's action.
2. **Enhancement proposals** for agents/flows the user already uses (e.g. "this agent fails on Mondays at the same step — add a retry/notify branch"), stored as `suggestion` memories linked to the pattern.

Quietness rules (hard, code-enforced): max one un-actioned suggestion per user; per-user weekly cadence cap; dismissal writes a `suggestion_dismissed` event **and** negative feedback that the similarity check suppresses.

## Component 5 — Surfaces

1. **Home assistant** (`src/features/assistant/workspace-context.ts`): add a GraphRAG retrieval pass (`retrieveContext` scoped to the user) plus the user's eligible patterns and org learnings, merged under the existing `assemble.ts` char budget. The assistant stays reactive — its answers now extrapolate from real usage — and its reply schema gains an optional single suggestion card, shown only when an un-actioned, eligible-pattern-backed suggestion exists.
2. **Flow copilot** (`src/lib/flows/copilot-grounding.ts`): `buildCopilotGrounding` gains the user's eligible patterns and relevant graph context so generated flows match observed behavior (their real agents, sequences, cadences).
3. **Per-agent improvement proposals:** the agent page surfaces enhancement proposals that join reflection output (`lastCritique`/`suggestedGoal`) with behavior evidence for that agent; each must pass the eligibility gate and cite the agent's own run/interaction history.

## Error handling & degradation

- `recordUserEvent` never throws into a request path.
- Projection/inference/synthesis no-op cleanly when `NEO4J_*` or `VOYAGE_API_KEY` are unset (MemoryGraphStore fallback for dev/tests; jobs check the same `ragEnabled` gates as existing code).
- All jobs run on the existing BullMQ worker with dead-letter queues; cron dispatch drives cadence.
- Surfaces degrade to current behavior when no eligible patterns exist (empty sections, no errors).

## Testing

- **Unit:** `isPatternEligible` (thresholds, learning period, dismissal similarity — the most important logic in the system), `recordUserEvent` (never-throws contract), event→graph projection mapping.
- **Integration (MemoryGraphStore + mocked LLM):** full pipeline — capture → project → infer → gate → draft suggestion with evidence metadata; and the negative case — below-threshold or in-learning-period patterns produce no suggestions and no assistant/copilot context entries.

## Out of scope (this effort)

Client-side analytics (page views/clicks); auto-activating generated flows or agents; cross-user or cross-org behavior learning; a distilled per-user profile document (possible later as a cached read view over the graph); changes to the org-level connection-scan pipeline.

## Implementation phasing (for the plan)

1. Ledger + capture (`UserEvent`, `recordUserEvent`, route call sites, retention).
2. Graph projection + backfill sweep.
3. Pattern inference + eligibility gate.
4. Per-user synthesis + quietness rules.
5. Surface wiring (assistant, copilot, agent proposals).

Each phase is independently shippable and testable; earlier phases deliver value (data accrues during the learning period) even before later phases land.
