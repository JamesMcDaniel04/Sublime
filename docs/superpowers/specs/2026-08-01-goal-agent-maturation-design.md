# Goal-agent maturation: arbitration, plan artifacts, contribution verdicts

**Date:** 2026-08-01
**Status:** Approved for implementation
**Branch:** feat/goal-recovery-plans

## Motivation

Benchmarked against the canonical goal-based agent model (goal definition →
planning → action selection → execution with diagnose/re-plan/escalate
recovery), Sublime's goal system has three gaps:

1. **No multi-goal arbitration.** An agent linked to several goals gets all
   their grounding blocks but no ranking; nothing tells it which goal wins
   when actions trade off.
2. **In-run plans are not artifacts.** Strategize mode asks the model to state
   a numbered plan in its first reply; the plan lives only in model text. No
   persistence, no plan-vs-actual verification, no structured re-plan on step
   failure.
3. **Run→goal contribution is unverified.** A run's clean finish and the
   goal's metric movement are decoupled. The reflection pass emits a freeform
   `goalAssessment` string that nothing consumes.

## 1. Multi-goal arbitration (risk-derived + user override)

### Schema

- `Goal.priority Int?` — nullable; null means "rank automatically." Lower
  number = more important. Editable through the existing goal PATCH route.

### New module: `src/lib/goals/arbitration.ts` (pure, zero I/O)

- `rankGoals(goals: { id; name; riskLevel; targetDate; priority }[])` —
  sort order:
  1. user priority ascending; any set priority outranks every unset one;
  2. risk severity: `off_track` > `at_risk` > `on_track` > `no_data`;
  3. nearest `targetDate`;
  4. id (deterministic tiebreak).
- `arbitrationSection(ranked)` — prompt block rendered only when the agent
  has ≥ 2 linked goals: the ranked list with each goal's risk level and
  deadline, plus the rule: *when actions trade off between goals, favor the
  higher-ranked one; never spend a turn on a lower-ranked goal while a
  higher-ranked one has an available next step.*

### Wiring (execute-agent.ts)

Where linked goal ids are resolved today, fetch `{ name, riskLevel,
targetDate, priority }` for each, rank, inject `arbitrationSection` into the
system prompt. The existing work-feedback loop keeps its bound of two goals
but loads them in ranked order (highest priority first) instead of arbitrary
order. Flows are out of scope.

## 2. Persisted in-run plans (plan tools + soft audit)

### Schema

- `AgentExecution.plan Json?` — not a new table: a plan is 1:1 with its run,
  read whole, and pruned with the run; nothing queries plans across runs.
  Shape:

  ```json
  {
    "steps": [{ "n": 1, "title": "...", "status": "pending|done|failed|skipped", "note": "..." }],
    "revisions": [{ "turn": 4, "reason": "..." }]
  }
  ```

### Tools (offered exactly when strategize mode fires)

- `set_plan(steps: string[])` — records the numbered plan; replaces the
  "state your plan in your first reply" instruction.
- `update_plan(stepN, status, note?, revisedSteps?)` — marks steps
  done/failed/skipped; `revisedSteps` after a failure records a structured
  re-plan and appends a revision entry with its reason.

`strategizeSection()` is rewritten to instruct this flow: call `set_plan`
before any other tool, update statuses as steps complete or fail, and revise
explicitly after a failure. The model is never blocked — no hard gate; the
tools are how the plan becomes real.

### Soft audit: `src/features/agents/plan-audit.ts` (pure)

Input: final plan JSON + whether strategize mode was on. Findings:

- `plan_never_set` — strategize fired but no plan was recorded;
- `steps_left_pending` — run finished with pending steps;
- `failed_step_no_revision` — a step failed and no revision followed.

Findings are stored on the execution's output metadata and appended to the
reflection prompt, so the self-critique (already injected into the next run)
addresses divergence. Plan-vs-actual closes through the existing learning
channel; no new delivery mechanism.

## 3. Run→goal contribution verdicts (evidence + escalation)

### Reflection change

`goalAssessment: string` is replaced by:

```json
"goalContribution": {
  "verdict": "advanced | no_change | unclear | counterproductive",
  "evidence": "one sentence grounded in the run summary"
}
```

Tolerant parse defaults the verdict to `unclear`. The old field is dropped —
nothing consumes it today.

### Schema: new table `goal_run_verdicts`

`{ id, organizationId, goalId, resourceType ('agent'|'flow'), resourceId,
runId, verdict, evidence, createdAt }`, indexed
`[organizationId, goalId, createdAt]`. `runId` is deliberately not an FK —
verdicts outlive run pruning (same reasoning documented on `GoalWork.runId`).
Written post-reflection for each linked goal, bounded to the same two goals
the prompt was grounded with.

### Consumer 1 — recovery evidence

`renderGoalEvidence` (emit-recommendation.ts) gains an aggregate line over
the last 30 days, e.g. *"9 agent runs completed; 7 judged non-advancing by
reflection."* Only rendered when verdict rows exist. The recovery diagnosis
finally sees the run→goal disconnect.

### Consumer 2 — escalation (pure streak detector)

Three consecutive non-advancing verdicts (`no_change` or `counterproductive`)
for one resource on a goal currently `at_risk`/`off_track` → emit a
`UserSuggestion` + notification to the goal owner: retarget the agent's
objective or pause it. Deduped once per streak: no re-nag until an `advanced`
verdict resets the streak. No automatic pausing — humans stay in the loop.

## Cross-cutting

- **Migration:** one migration covering `Goal.priority`,
  `AgentExecution.plan`, and `goal_run_verdicts`. Deploy to the persistent QA
  Postgres before trusting test results (known gotcha).
- **Testing:** every decision surface is a pure module with unit tests
  (`arbitration`, `plan-audit`, streak detector, verdict parsing, tool
  handlers), matching the repo's established pattern. One e2e-style test
  extends the goal-recovery e2e to cover the verdict evidence line.
- **Out of scope (YAGNI):** flows in arbitration, plan-rendering UI beyond
  the stored artifact, utility functions/weights, automatic throttling or
  pausing of agents.
