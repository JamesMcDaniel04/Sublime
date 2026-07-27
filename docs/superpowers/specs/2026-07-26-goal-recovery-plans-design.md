# Goal Recovery Plans — Design

**Date:** 2026-07-26
**Status:** Approved for planning
**Sub-project 1 of 3** in the "goals leverage AI" arc:

1. **AI recovery plans** (this spec)
2. Goal-aligned agent catalogue expansion (own spec, next)
3. New metric adapters — GA4, accounting (QuickBooks or Xero, pick at spec time), delivery (Linear or Jira, pick at spec time) (own specs, last)

Build order rationale: recovery plans degrade gracefully when the catalogue and adapter set are thin ("connect a tool" is itself a recommendation); the catalogue makes plans immediately better; each new adapter both feeds goals and gives plans more to recommend.

## Problem

Goals today track and alert but do not advise. When a goal worsens, `emit-recommendation.ts` creates one flat `UserSuggestion` whose template pick is adoption-ranked, not reasoned. Users get told they are off track, not what to do, what to connect, or what to run.

## Decision summary (from brainstorming)

- **Trigger:** reactive only — worsening risk transitions, as today. No always-on advisor, no on-demand chat.
- **Agent source:** curated seed catalogue only; the LLM selects and personalizes, never authors agents.
- **Tool recommendations:** from the existing adapter set plus integrations required by recommended agent templates. (New adapters are sub-project 3.)
- **Action depth:** one-click launch — accepting an agent recommendation provisions it pre-configured, linked via `GoalContribution`, and scheduled. Risky agent behavior uses the existing agent approval flow.

## Data model

Two new Prisma models in the goals spine.

### `GoalRecoveryPlan`

| Field | Notes |
| --- | --- |
| `id`, `orgId`, `goalId` | FK to `Goal`; cascade delete with goal |
| `status` | `open \| resolved \| superseded \| dismissed` |
| `triggerRiskLevel` | `at_risk \| off_track` — the level that generated it |
| `diagnosis` | LLM-written text, grounded in measured facts only |
| `evidence` | JSON — the measured-fact lines from `renderGoalEvidence` at generation time |
| `modelMeta` | JSON — model id, latency, fallback flag |
| `createdAt`, `resolvedAt` | |

Constraint: **at most one `open` plan per goal** (partial unique index on `(goalId) WHERE status = 'open'`).

### `GoalRecoveryAction`

| Field | Notes |
| --- | --- |
| `id`, `planId` | FK, cascade delete with plan |
| `kind` | `connect_tool \| launch_agent \| manual_step` |
| `title`, `rationale` | LLM-personalized; rationale must reference the goal's evidence |
| `payload` | JSON per kind: `{ sourceId }` for connect_tool; `{ seedTemplateId, config }` (goal-prefilled) for launch_agent; `{}` for manual_step |
| `status` | `proposed \| accepted \| done \| dismissed` |
| `rank` | display order from the LLM |
| `resultRef` | id of the created `AgentTask` or connection, once acted on |
| `acceptedAt` | |

`UserSuggestion` is retained as the alert vehicle: the goal_action suggestion now carries a `planId` pointer instead of a single template pick. Notification (`notify('goal.risk')`), digest, and dedup logic are unchanged.

## Generation pipeline

Trigger point unchanged: the worsening-transition hook in `src/lib/goals/emit-recommendation.ts`, invoked from evaluation in `src/lib/goals/refresh.ts`.

1. **Deterministic candidate assembly** (no LLM):
   - Metric series stats from the `evaluate.ts` output (progress, expected progress, projection, pace delta).
   - Connected sources from `available-sources.ts`.
   - Top-N (N=6) adoption-ranked agent templates from `goalTemplatesFor(goal.kind)`.
   - Source gap: the goal template's ranked `sources[]` minus connected sources; plus `requiredIntegrations` of candidate agent templates that are unconnected.
2. **One `generateStructured` call** (via `model-runner.ts`) against `RECOVERY_PLAN_SCHEMA`:
   - Input: goal summary, evidence lines, candidate sets with ids.
   - Output: `diagnosis` + 2–5 actions. Each action's `sourceId`/`seedTemplateId` **must come from the provided candidate ids**. Free text is limited to `title` and `rationale`.
   - Post-hoc validation drops any action whose id is not in the candidate set; if fewer than 1 action survives, treat as LLM failure.
3. **Transactional persist**: supersede any prior open plan, insert plan + actions, upsert the pointer `UserSuggestion`, notify as today.
4. **Fallback**: on any LLM error, timeout, or empty validated result → today's rule-based suggestion fires exactly as it does now (adoption-ranked template pick, evidence lines). AI failure never blocks or degrades evaluation.

Cost bound: one LLM call per worsening transition per goal, already dedup-gated.

## UX

- **Goal dashboard strip**: an open plan renders as a fixed "Get back on track" section above the widget grid — not a widget, because layouts are user-editable and the plan must be un-missable. Contents: diagnosis, evidence lines, ranked action cards. Disappears when no open plan.
- **Action cards**:
  - `connect_tool`: button deep-links into the existing source-connection flow. On a later evaluation, if the source is connected, the action auto-completes.
  - `launch_agent`: one click calls the provisioning path (`/api/templates/provision` semantics) with the goal binding — creating the agent pre-configured, writing the `GoalContribution`, and scheduling it. Card flips to "Running" with a link to the agent. Approval-worthy agent actions use the existing agent approval flow.
  - `manual_step`: mark-done checkbox.
- Per-action dismiss and whole-plan dismiss.
- Notification and weekly digest link to the goal dashboard (plan strip is at top).

## API

- Plan + actions included in the goal detail payload (no extra fetch).
- `POST /api/goals/[id]/recovery/actions/[actionId]/accept` — executes per-kind behavior (provision / deep-link target payload / mark done).
- `POST /api/goals/[id]/recovery/actions/[actionId]/dismiss`
- `POST /api/goals/[id]/recovery/dismiss` — dismisses the plan.

All org/ownership authorization mirrors existing goal routes.

## Lifecycle rules

- Goal transitions to `on_track` → open plan auto-`resolved` during evaluation (`resolvedAt` set); strip disappears.
- Further worsening while a plan is open (`at_risk` → `off_track`) → old plan `superseded`, new plan generated.
- Same-level re-transitions or flapping → no regeneration (existing transition dedup applies).
- Launched agents' runs accrue to the goal through existing `GoalContribution` impact accounting — no new attribution code.

## Error handling

- LLM failure → no plan row is created; the legacy rule-based suggestion fires instead, and the failure is logged. (`modelMeta` exists only on successfully generated plans.)
- One-click provision failure → action remains `accepted` with visible retry; never a silent no-op.
- Invalid/stale candidate ids at accept time (e.g. template removed) → error surfaced on the card; action can be dismissed.

## Testing

- Unit: candidate assembly (source gap math, top-N ranking), schema validation and id filtering, supersede/resolve/dismiss transitions, auto-complete of connect_tool actions.
- Integration: full worsening-transition → plan persistence path with a stubbed LLM (deterministic fixture), and the fallback path with a failing stub.
- Route smoke via the repo's `/verify` harness (throwaway Postgres + seeded auth; no cloud credentials).

## Out of scope (this sub-project)

- Always-on / steady-state recommendations; on-demand "ask AI" on goals.
- Authoring new agent templates (sub-project 2).
- New metric-source adapters (sub-project 3).
- Per-goal alert threshold/channel configuration.
- Forecast or what-if simulation.
