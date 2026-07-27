# Sublime Goals Tool Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give agents and flows live read/write access to the goals they are linked to, via a fifth native tool plane (`native:sublime-goals`).

**Architecture:** A new built-in connector descriptor plus a `GoalsToolClient` that is *constructed with the already-resolved set of linked goal ids* — authorization is a construction-time property, not a runtime check. Database access goes through an injected `GoalsDataPort` so the client unit-tests without Prisma, mirroring how `SlackToolClient` injects `fetch`. Writes are gated by a pure policy module that permits only metric sources an AI or human already owns.

**Tech Stack:** TypeScript, Next.js, Prisma, `node:test` + `node:assert/strict` run through `tsx`.

**Spec:** `docs/superpowers/specs/2026-07-27-sublime-goals-tool-plane-design.md`

## Global Constraints

- Writable metric sources are exactly `manual`, `slack_assisted`, `gmail_assisted`. Every other source is refused.
- Datapoint writes use `origin: 'assisted'` — never a new origin value, never `'sync'`.
- Scoping is linked-goals-only for read *and* write, resolved from `GoalContribution` at plane-load time.
- The goals group is **absent** (not empty) when the resource has no linked goal.
- No Prisma migration. No schema change. No new UI.
- Tests use `node:test` + `node:assert/strict`, no live LLM, no live database.
- Run a single test file with: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <path>`
- Run the full suite with: `npm test`
- Typecheck with: `npx tsc --noEmit -p tsconfig.json`

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/goals/agent-tool-policy.ts` (create) | Pure write policy: source allowlist, refusal message, `capturedAt` validation. No I/O. |
| `src/lib/integrations/goals.ts` (create) | `goalsTools()` definitions, `GoalsDataPort` interface, `GoalsToolClient`. **Must not import Prisma** — that is what keeps it unit-testable. |
| `src/lib/integrations/goals-port.ts` (create) | The Prisma-backed `GoalsDataPort` implementation. The only file here that touches the database. |
| `src/lib/connectors/registry.ts` (modify) | One `ConnectorDescriptor` entry. |
| `src/features/agents/tool-planes.ts` (modify) | `resource` option on `loadNativePlaneGroups`; resolve linked goals; build the group. |
| `src/features/agents/execute-agent.ts` (modify) | Thread the running agent's id through `loadTools`. |
| `src/lib/flows/tool-catalog.ts` (modify) | Pass an optional `resource` through to the native loader. |

Splitting the port from the client is deliberate: `src/lib/integrations/__tests__/slack.test.ts` injects `fetch` to test a client with no network, and the same trick needs the database behind an interface. Importing `@/lib/prisma` into `goals.ts` would drag a Prisma client into every test that imports the tool client.

---

### Task 1: Write policy (pure)

**Files:**
- Create: `src/lib/goals/agent-tool-policy.ts`
- Test: `src/lib/goals/__tests__/agent-tool-policy.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module)
- Produces: `AGENT_WRITABLE_SOURCES: ReadonlySet<string>`, `AGENT_DATAPOINT_ORIGIN: 'assisted'`, `canWriteDatapoint(source: string): boolean`, `writeRefusalMessage(source: string): string`, `assertCapturedAt(capturedAt: Date, goalCreatedAt: Date, now: Date): void`

- [ ] **Step 1: Write the failing test**

Create `src/lib/goals/__tests__/agent-tool-policy.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_DATAPOINT_ORIGIN,
  AGENT_WRITABLE_SOURCES,
  assertCapturedAt,
  canWriteDatapoint,
  writeRefusalMessage,
} from '@/lib/goals/agent-tool-policy'
import { METRIC_SOURCES } from '@/lib/goals/metric-sources'

test('only AI/human-owned sources are writable, and the allowlist is a real subset', () => {
  for (const source of ['manual', 'slack_assisted', 'gmail_assisted']) {
    assert.equal(canWriteDatapoint(source), true, `${source} should be writable`)
  }
  for (const source of ['stripe', 'hubspot', 'salesforce', 'google_sheets', 'postgres', 'url']) {
    assert.equal(canWriteDatapoint(source), false, `${source} must never be writable`)
  }
  // Guards against a future metric source silently defaulting into the allowlist.
  for (const source of AGENT_WRITABLE_SOURCES) {
    assert.ok(
      (METRIC_SOURCES as readonly string[]).includes(source),
      `${source} is not a real metric source`,
    )
  }
})

test('agent writes are pinned to the existing assisted origin', () => {
  // The value is consumed by goals-port.ts, which needs a database to test.
  // Pinning it here is the regression guard: changing it to 'agent' or 'sync'
  // would silently break the UI's existing "AI-read" labeling.
  assert.equal(AGENT_DATAPOINT_ORIGIN, 'assisted')
})

test('the refusal names the owning system so the model does not retry blindly', () => {
  const message = writeRefusalMessage('stripe')
  assert.match(message, /Stripe/)
  assert.match(message, /Report the number in your output instead/)
  // An unmapped source still produces a usable sentence rather than "undefined".
  assert.match(writeRefusalMessage('mystery_source'), /mystery_source/)
})

test('capturedAt refuses the future and anything pre-dating the goal', () => {
  const now = new Date('2026-07-27T12:00:00Z')
  const created = new Date('2026-07-01T00:00:00Z')

  assert.doesNotThrow(() => assertCapturedAt(new Date('2026-07-20T09:00:00Z'), created, now))
  assert.doesNotThrow(() => assertCapturedAt(now, created, now))

  assert.throws(
    () => assertCapturedAt(new Date('2026-07-28T00:00:00Z'), created, now),
    /future/,
  )
  assert.throws(
    () => assertCapturedAt(new Date('2026-06-30T23:59:00Z'), created, now),
    /pre-date/,
  )
  assert.throws(() => assertCapturedAt(new Date('nonsense'), created, now), /valid date/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/agent-tool-policy.test.ts`
Expected: FAIL — cannot find module `@/lib/goals/agent-tool-policy`

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/goals/agent-tool-policy.ts`:

```ts
/**
 * Write policy for the sublime-goals agent tool plane. Pure — no I/O, no
 * Prisma — so the rules that protect the tracked number are exhaustively
 * unit-testable.
 *
 * MetricDatapoint is unique on (goalMetricId, bucketKey), so a same-day write
 * REPLACES that day's row rather than appending. An unrestricted write could
 * therefore overwrite a synced Stripe reading with a model's guess. The
 * allowlist removes that structurally: a metric owned by a system of record has
 * no reachable write path at all.
 */

/** Sources where a human or an AI already supplies the number, so an agent
 *  write cannot displace a system of record. */
export const AGENT_WRITABLE_SOURCES: ReadonlySet<string> = new Set([
  'manual',
  'slack_assisted',
  'gmail_assisted',
])

/**
 * Origin stamped on an agent-written datapoint. Reuses the EXISTING 'assisted'
 * value that slack_assisted/gmail_assisted syncs already produce, so the UI's
 * "AI-read" labeling applies with no migration and no UI change. Never
 * introduce a distinct 'agent' origin without updating every reader.
 */
export const AGENT_DATAPOINT_ORIGIN = 'assisted' as const

/**
 * How to name each read-only source in a refusal. Deliberately local rather
 * than reusing the UI's SOURCE_LABELS ("Postgres / SQL", "I'll record values
 * myself") — those read as form options, not as the name of a system of record
 * in an error sentence.
 */
const OWNER_LABELS: Record<string, string> = {
  stripe: 'Stripe',
  hubspot: 'HubSpot',
  salesforce: 'Salesforce',
  google_sheets: 'Google Sheets',
  postgres: 'Postgres',
  url: 'a URL',
}

export function canWriteDatapoint(source: string): boolean {
  return AGENT_WRITABLE_SOURCES.has(source)
}

export function writeRefusalMessage(source: string): string {
  const owner = OWNER_LABELS[source] ?? source
  return `Cannot write this goal's value — it is tracked from ${owner}. Report the number in your output instead.`
}

/**
 * Reject the two timestamps that would let a model fabricate history: a future
 * reading, and one pre-dating the goal itself. Backfilling older periods stays
 * a human action through the CSV import path.
 */
export function assertCapturedAt(capturedAt: Date, goalCreatedAt: Date, now: Date): void {
  if (Number.isNaN(capturedAt.getTime())) {
    throw new Error('capturedAt is not a valid date')
  }
  if (capturedAt.getTime() > now.getTime()) {
    throw new Error('capturedAt cannot be in the future')
  }
  if (capturedAt.getTime() < goalCreatedAt.getTime()) {
    throw new Error(
      'capturedAt cannot pre-date the goal — use CSV import to backfill history',
    )
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/agent-tool-policy.test.ts`
Expected: PASS — 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/goals/agent-tool-policy.ts src/lib/goals/__tests__/agent-tool-policy.test.ts
git commit -m "feat(goals): add agent datapoint write policy"
```

---

### Task 2: Tool definitions and read path

**Files:**
- Create: `src/lib/integrations/goals.ts`
- Test: `src/lib/integrations/__tests__/goals.test.ts`

**Interfaces:**
- Consumes: `evaluateGoal`, `EvalPoint` from `@/lib/goals/evaluate`
- Produces:
  - `goalsTools(): ToolDefinition[]`
  - `type AgentGoalView` — `{ id, name, kind, unit, direction, startValue, targetValue, startAt, targetDate, recurrence, createdAt, primarySource, refreshIntervalHours }`
  - `type GoalsDataPort` — `{ getGoal(goalId): Promise<AgentGoalView | null>; listDatapoints(goalId, limit): Promise<{ value: number; capturedAt: Date }[]>; writeDatapoint(goalId, value, capturedAt): Promise<void> }`
  - `class GoalsToolClient` — `constructor(goalIds: string[], port: GoalsDataPort, now?: () => Date)`, `executeTool(serverUrl: string, name: string, args: Record<string, unknown>): Promise<unknown>`
  - `const DATAPOINT_LIMIT = 90`

- [ ] **Step 1: Write the failing test**

Create `src/lib/integrations/__tests__/goals.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DATAPOINT_LIMIT,
  GoalsToolClient,
  goalsTools,
  type AgentGoalView,
  type GoalsDataPort,
} from '@/lib/integrations/goals'

const NOW = new Date('2026-07-27T12:00:00Z')

function goalView(overrides: Partial<AgentGoalView> = {}): AgentGoalView {
  return {
    id: 'goal-a',
    name: 'Quarterly revenue',
    kind: 'revenue',
    unit: 'usd',
    direction: 'increase',
    startValue: 0,
    targetValue: 1000,
    startAt: new Date('2026-07-01T00:00:00Z'),
    targetDate: new Date('2026-07-31T00:00:00Z'),
    recurrence: 'quarterly',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    primarySource: 'manual',
    refreshIntervalHours: 24,
    ...overrides,
  }
}

function fakePort(
  goals: Record<string, AgentGoalView>,
  points: Record<string, { value: number; capturedAt: Date }[]> = {},
): GoalsDataPort & { writes: { goalId: string; value: number; capturedAt: Date }[] } {
  const writes: { goalId: string; value: number; capturedAt: Date }[] = []
  return {
    writes,
    async getGoal(goalId) {
      return goals[goalId] ?? null
    },
    async listDatapoints(goalId, limit) {
      return (points[goalId] ?? []).slice(0, limit)
    },
    async writeDatapoint(goalId, value, capturedAt) {
      writes.push({ goalId, value, capturedAt })
    },
  }
}

test('goalsTools exposes exactly the four documented tools, one of them a write', () => {
  const names = goalsTools().map((tool) => tool.name).sort()
  assert.deepEqual(names, ['get_goal', 'get_pace', 'list_datapoints', 'log_datapoint'])
  for (const tool of goalsTools()) {
    assert.ok(tool.description.length > 20, `${tool.name} needs a usable description`)
    assert.equal((tool.inputSchema as { type: string }).type, 'object')
  }
})

test('a single linked goal makes goalId optional', async () => {
  const client = new GoalsToolClient(['goal-a'], fakePort({ 'goal-a': goalView() }), () => NOW)
  const result = (await client.executeTool('', 'get_goal', {})) as { name: string }
  assert.equal(result.name, 'Quarterly revenue')
})

test('a goal outside the linked set is refused, not silently empty', async () => {
  const client = new GoalsToolClient(['goal-a'], fakePort({ 'goal-a': goalView() }), () => NOW)
  await assert.rejects(
    () => client.executeTool('', 'get_goal', { goalId: 'goal-b' }),
    /not linked/,
  )
})

test('with several linked goals, goalId is required rather than guessed', async () => {
  const client = new GoalsToolClient(
    ['goal-a', 'goal-b'],
    fakePort({ 'goal-a': goalView(), 'goal-b': goalView({ id: 'goal-b' }) }),
    () => NOW,
  )
  await assert.rejects(() => client.executeTool('', 'get_goal', {}), /goalId is required/)
})

test('get_pace agrees with evaluateGoal and reports days remaining', async () => {
  const points = [
    { value: 100, capturedAt: new Date('2026-07-20T00:00:00Z') },
    { value: 400, capturedAt: new Date('2026-07-27T00:00:00Z') },
  ]
  const client = new GoalsToolClient(
    ['goal-a'],
    fakePort({ 'goal-a': goalView() }, { 'goal-a': points }),
    () => NOW,
  )
  const pace = (await client.executeTool('', 'get_pace', {})) as {
    currentValue: number
    riskLevel: string
    daysRemaining: number
  }
  assert.equal(pace.currentValue, 400)
  // 0..1000 over July; on 27 July expected pace is ~0.84, actual is 0.40.
  assert.equal(pace.riskLevel, 'off_track')
  assert.equal(pace.daysRemaining, 4)
})

test('list_datapoints is bounded so a long goal cannot flood the context', async () => {
  const many = Array.from({ length: 500 }, (_, index) => ({
    value: index,
    capturedAt: new Date(Date.UTC(2026, 0, 1 + index)),
  }))
  const client = new GoalsToolClient(
    ['goal-a'],
    fakePort({ 'goal-a': goalView() }, { 'goal-a': many }),
    () => NOW,
  )
  const result = (await client.executeTool('', 'list_datapoints', {})) as { points: unknown[] }
  assert.equal(result.points.length, DATAPOINT_LIMIT)
})

test('an unknown tool name is rejected', async () => {
  const client = new GoalsToolClient(['goal-a'], fakePort({ 'goal-a': goalView() }), () => NOW)
  await assert.rejects(() => client.executeTool('', 'delete_goal', {}), /Unknown goals tool/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/integrations/__tests__/goals.test.ts`
Expected: FAIL — cannot find module `@/lib/integrations/goals`

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/integrations/goals.ts`:

```ts
/**
 * Sublime Goals integration — the built-in agent tool plane for reading and
 * updating the goals a resource is linked to.
 *
 * Deliberately Prisma-free: all database access goes through GoalsDataPort so
 * the client unit-tests with a fake, the same way SlackToolClient injects
 * fetch. The Prisma-backed port lives in ./goals-port.
 *
 * Authorization is NOT enforced in this file's logic — it is a property of
 * construction. The client receives an already-resolved set of goal ids from
 * the plane loader and has no query that could reach any other goal.
 */

import type { ToolDefinition } from '@/lib/llm/model-runner'
import { evaluateGoal, type EvalPoint } from '@/lib/goals/evaluate'
import {
  assertCapturedAt,
  canWriteDatapoint,
  writeRefusalMessage,
} from '@/lib/goals/agent-tool-policy'

/** Bounded history: a multi-year goal must not flood the context window. */
export const DATAPOINT_LIMIT = 90

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export type AgentGoalView = {
  id: string
  name: string
  kind: string
  unit: string
  direction: 'increase' | 'decrease'
  startValue: number
  targetValue: number
  startAt: Date
  targetDate: Date
  recurrence: string | null
  createdAt: Date
  /** Source of the primary metric, or null when the goal has no metric yet. */
  primarySource: string | null
  refreshIntervalHours: number
}

export type GoalsDataPort = {
  getGoal(goalId: string): Promise<AgentGoalView | null>
  listDatapoints(goalId: string, limit: number): Promise<{ value: number; capturedAt: Date }[]>
  writeDatapoint(goalId: string, value: number, capturedAt: Date): Promise<void>
}

export function goalsTools(): ToolDefinition[] {
  const goalId = {
    type: 'string',
    description:
      'Which linked goal to act on. Optional when this agent is linked to exactly one goal.',
  }
  return [
    {
      name: 'get_goal',
      description:
        "Read the definition of a goal you are working toward: its name, target value, target date, unit, direction and recurrence. Call this first so you know what success means before doing anything else.",
      inputSchema: { type: 'object', properties: { goalId }, required: [] },
    },
    {
      name: 'get_pace',
      description:
        'Read how the goal is actually tracking: current value, expected-vs-actual progress, projected final value, risk level and days remaining. Use this to decide whether intervention is needed and how urgent it is.',
      inputSchema: { type: 'object', properties: { goalId }, required: [] },
    },
    {
      name: 'list_datapoints',
      description: `Read the goal's recent measured history, newest first (up to ${DATAPOINT_LIMIT} readings). Use it to spot trends, stalls and reversals rather than reasoning from a single number.`,
      inputSchema: { type: 'object', properties: { goalId }, required: [] },
    },
    {
      name: 'log_datapoint',
      description:
        "Record a value for a goal you track manually or read with AI. Only works when nobody else owns the number — a goal wired to Stripe, a CRM, a warehouse or a URL is read automatically and will refuse this call. Recorded values are labeled AI-read.",
      inputSchema: {
        type: 'object',
        properties: {
          goalId,
          value: { type: 'number', description: 'The measured value to record.' },
          capturedAt: {
            type: 'string',
            description:
              'Optional ISO-8601 timestamp for the reading. Defaults to now. Cannot be in the future or before the goal was created.',
          },
        },
        required: ['value'],
      },
    },
  ]
}

export class GoalsToolClient {
  constructor(
    private readonly goalIds: string[],
    private readonly port: GoalsDataPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The whole authorization surface. Anything not in the constructed set is
   *  refused loudly rather than returning empty — a mis-scoped call is a bug,
   *  not an absence of data. */
  private resolveGoalId(raw: unknown): string {
    if (raw === undefined || raw === null || raw === '') {
      if (this.goalIds.length === 1) return this.goalIds[0]
      throw new Error(
        `goalId is required — this agent is linked to ${this.goalIds.length} goals (${this.goalIds.join(', ')})`,
      )
    }
    const id = String(raw)
    if (!this.goalIds.includes(id)) {
      throw new Error(`Goal ${id} is not linked to this agent`)
    }
    return id
  }

  private async loadGoal(raw: unknown): Promise<AgentGoalView> {
    const goalId = this.resolveGoalId(raw)
    const goal = await this.port.getGoal(goalId)
    if (!goal) throw new Error(`Goal ${goalId} no longer exists`)
    return goal
  }

  async executeTool(
    _serverUrl: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (name === 'get_goal') {
      const goal = await this.loadGoal(args.goalId)
      return {
        id: goal.id,
        name: goal.name,
        kind: goal.kind,
        unit: goal.unit,
        direction: goal.direction,
        startValue: goal.startValue,
        targetValue: goal.targetValue,
        startAt: goal.startAt.toISOString(),
        targetDate: goal.targetDate.toISOString(),
        recurrence: goal.recurrence,
        trackedFrom: goal.primarySource,
        writable: goal.primarySource !== null && canWriteDatapoint(goal.primarySource),
      }
    }

    if (name === 'get_pace') {
      const goal = await this.loadGoal(args.goalId)
      const points = await this.port.listDatapoints(goal.id, DATAPOINT_LIMIT)
      const now = this.now()
      // Same staleness window the goal detail API uses, so the agent sees the
      // number the dashboard shows rather than a second opinion.
      // Port returns newest-first; evaluateGoal wants oldest-first.
      const ordered: EvalPoint[] = [...points].reverse()
      const evaluation = evaluateGoal(
        goal,
        ordered,
        now,
        2 * goal.refreshIntervalHours * HOUR_MS,
      )
      const daysRemaining = Math.max(
        0,
        Math.ceil((goal.targetDate.getTime() - now.getTime()) / DAY_MS),
      )
      const remainingValue = goal.targetValue - (evaluation.currentValue ?? goal.startValue)
      return {
        currentValue: evaluation.currentValue,
        targetValue: goal.targetValue,
        progress: evaluation.progress,
        expectedProgress: evaluation.expectedProgress,
        projectedValue: evaluation.projectedValue,
        riskLevel: evaluation.riskLevel,
        daysRemaining,
        requiredPerDay: daysRemaining > 0 ? remainingValue / daysRemaining : null,
      }
    }

    if (name === 'list_datapoints') {
      const goal = await this.loadGoal(args.goalId)
      const points = await this.port.listDatapoints(goal.id, DATAPOINT_LIMIT)
      return {
        unit: goal.unit,
        points: points.map((point) => ({
          value: point.value,
          capturedAt: point.capturedAt.toISOString(),
        })),
      }
    }

    if (name === 'log_datapoint') {
      const goal = await this.loadGoal(args.goalId)
      if (!goal.primarySource) {
        throw new Error('This goal has no metric configured yet, so there is nothing to write to.')
      }
      if (!canWriteDatapoint(goal.primarySource)) {
        throw new Error(writeRefusalMessage(goal.primarySource))
      }
      const value = Number(args.value)
      if (!Number.isFinite(value)) throw new Error('value must be a finite number')

      const now = this.now()
      const capturedAt = args.capturedAt ? new Date(String(args.capturedAt)) : now
      assertCapturedAt(capturedAt, goal.createdAt, now)

      await this.port.writeDatapoint(goal.id, value, capturedAt)
      return {
        ok: true,
        goalId: goal.id,
        value,
        capturedAt: capturedAt.toISOString(),
        labeledAs: 'AI-read',
      }
    }

    throw new Error(`Unknown goals tool: ${name}`)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/integrations/__tests__/goals.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/integrations/goals.ts src/lib/integrations/__tests__/goals.test.ts
git commit -m "feat(goals): add goals tool definitions and read path"
```

---

### Task 3: Write path enforcement

**Files:**
- Modify: `src/lib/integrations/__tests__/goals.test.ts` (append tests only — the implementation from Task 2 already covers this path)

**Interfaces:**
- Consumes: `GoalsToolClient`, `GoalsDataPort`, `AgentGoalView` from Task 2; policy helpers from Task 1
- Produces: nothing new — this task proves the write gate holds

This task adds no production code. Task 2's `log_datapoint` branch is written; what it lacks is proof that the gate cannot be walked around. A reviewer can reject this task (insufficient coverage) while accepting Task 2, which is why it stands alone.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/integrations/__tests__/goals.test.ts`:

```ts
test('log_datapoint writes on every AI/human-owned source, labeled AI-read', async () => {
  for (const source of ['manual', 'slack_assisted', 'gmail_assisted']) {
    const port = fakePort({ 'goal-a': goalView({ primarySource: source }) })
    const client = new GoalsToolClient(['goal-a'], port, () => NOW)
    const result = (await client.executeTool('', 'log_datapoint', { value: 512 })) as {
      ok: boolean
      labeledAs: string
    }
    assert.equal(result.ok, true)
    assert.equal(result.labeledAs, 'AI-read')
    assert.deepEqual(port.writes, [{ goalId: 'goal-a', value: 512, capturedAt: NOW }])
  }
})

test('log_datapoint refuses every system-of-record source and writes nothing', async () => {
  for (const source of ['stripe', 'hubspot', 'salesforce', 'google_sheets', 'postgres', 'url']) {
    const port = fakePort({ 'goal-a': goalView({ primarySource: source }) })
    const client = new GoalsToolClient(['goal-a'], port, () => NOW)
    await assert.rejects(
      () => client.executeTool('', 'log_datapoint', { value: 512 }),
      /Cannot write this goal's value/,
      `${source} must refuse the write`,
    )
    assert.deepEqual(port.writes, [], `${source} must not have written`)
  }
})

test('log_datapoint refuses a goal with no metric configured', async () => {
  const port = fakePort({ 'goal-a': goalView({ primarySource: null }) })
  const client = new GoalsToolClient(['goal-a'], port, () => NOW)
  await assert.rejects(
    () => client.executeTool('', 'log_datapoint', { value: 1 }),
    /no metric configured/,
  )
  assert.deepEqual(port.writes, [])
})

test('log_datapoint refuses a non-numeric or future reading', async () => {
  const port = fakePort({ 'goal-a': goalView({ primarySource: 'manual' }) })
  const client = new GoalsToolClient(['goal-a'], port, () => NOW)

  await assert.rejects(
    () => client.executeTool('', 'log_datapoint', { value: 'lots' }),
    /finite number/,
  )
  await assert.rejects(
    () => client.executeTool('', 'log_datapoint', { value: 1, capturedAt: '2026-08-01T00:00:00Z' }),
    /future/,
  )
  assert.deepEqual(port.writes, [])
})

test('an unlinked goal cannot be written to even when its source is writable', async () => {
  const port = fakePort({
    'goal-a': goalView({ primarySource: 'manual' }),
    'goal-b': goalView({ id: 'goal-b', primarySource: 'manual' }),
  })
  const client = new GoalsToolClient(['goal-a'], port, () => NOW)
  await assert.rejects(
    () => client.executeTool('', 'log_datapoint', { goalId: 'goal-b', value: 9 }),
    /not linked/,
  )
  assert.deepEqual(port.writes, [])
})
```

- [ ] **Step 2: Run tests to verify the new ones pass and nothing regressed**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/integrations/__tests__/goals.test.ts`
Expected: PASS — 12 tests total

If any refusal test fails, the gate is wrong in Task 2's implementation, not in the test — fix `goals.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/integrations/__tests__/goals.test.ts
git commit -m "test(goals): prove the datapoint write gate holds"
```

---

### Task 4: Connector descriptor

**Files:**
- Modify: `src/lib/connectors/registry.ts` (append one entry to `BUILTIN_CONNECTORS`, after the `HTTP API` entry ending at line 85)
- Test: `src/lib/connectors/__tests__/goals-connector.test.ts`

**Interfaces:**
- Consumes: `ConnectorDescriptor`, `BUILTIN_CONNECTORS` from `@/lib/connectors/registry`
- Produces: a descriptor with `providerId: 'sublime-goals'`, discoverable via `BUILTIN_CONNECTORS.find((c) => c.providerId === 'sublime-goals')`

- [ ] **Step 1: Write the failing test**

Create `src/lib/connectors/__tests__/goals-connector.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_CONNECTORS, isSelected } from '@/lib/connectors/registry'
import {
  formatFlowToolConnectionId,
  parseFlowToolConnectionId,
} from '@/lib/flows/tool-connection-id'

const descriptor = () => BUILTIN_CONNECTORS.find((c) => c.providerId === 'sublime-goals')

test('the goals connector is registered as a write-capable built-in', () => {
  const goals = descriptor()
  assert.ok(goals, 'sublime-goals is not in BUILTIN_CONNECTORS')
  assert.equal(goals.kind, 'builtin')
  assert.equal(goals.isWrite, true)
  assert.equal(goals.available(), true)
})

test('the goals connector activates only for an agent that selected it', () => {
  const goals = descriptor()!
  assert.equal(isSelected(goals, ['goals']), true)
  assert.equal(isSelected(goals, ['Goals']), true)
  // An agent that never asked for goal access must not receive the tools.
  assert.equal(isSelected(goals, ['slack', 'hubspot']), false)
})

test('the goals connection id round-trips through the plane scheme', () => {
  const id = formatFlowToolConnectionId('native', descriptor()!.providerId)
  assert.equal(id, 'native:sublime-goals')
  assert.deepEqual(parseFlowToolConnectionId(id), { plane: 'native', ref: 'sublime-goals' })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/connectors/__tests__/goals-connector.test.ts`
Expected: FAIL — "sublime-goals is not in BUILTIN_CONNECTORS"

- [ ] **Step 3: Write minimal implementation**

In `src/lib/connectors/registry.ts`, insert this object into the `BUILTIN_CONNECTORS` array immediately after the `HTTP API` entry (which ends with `available: () => true, // no credentials required; SSRF-guarded at call time` followed by `},`) and before the `// Nango delivery planes` comment:

```ts
  {
    key: 'goals',
    label: 'Goals',
    slug: 'sublime',
    kind: 'builtin',
    isWrite: true, // can record datapoints on AI/human-owned metrics
    providerId: 'sublime-goals',
    matches: has('goal'),
    available: () => true, // no credentials; scoped by GoalContribution at load time
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/connectors/__tests__/goals-connector.test.ts`
Expected: PASS — 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/connectors/registry.ts src/lib/connectors/__tests__/goals-connector.test.ts
git commit -m "feat(goals): register the sublime-goals built-in connector"
```

---

### Task 5: Prisma port and plane loader

**Files:**
- Create: `src/lib/integrations/goals-port.ts`
- Modify: `src/features/agents/tool-planes.ts` (the `loadNativePlaneGroups` signature at line 202, and a new group block after the Email block)
- Test: `src/features/agents/__tests__/goals-plane.test.ts`

**Interfaces:**
- Consumes: `GoalsToolClient`, `goalsTools`, `GoalsDataPort` (Task 2); the descriptor (Task 4)
- Produces:
  - `prismaGoalsPort(organizationId: string): GoalsDataPort`
  - `resolveLinkedGoalIds(organizationId, resource, db): Promise<string[]>` — exported from `goals-port.ts` so the scoping query is testable without booting a plane
  - `loadNativePlaneGroups(organizationId, options)` gains `options.resource?: { type: 'agent' | 'flow'; id: string }`

- [ ] **Step 1: Write the failing test**

Create `src/features/agents/__tests__/goals-plane.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveLinkedGoalIds } from '@/lib/integrations/goals-port'

type Row = { goalId: string }

function fakeDb(rows: Row[]) {
  const calls: unknown[] = []
  return {
    calls,
    goalContribution: {
      async findMany(args: unknown) {
        calls.push(args)
        return rows
      },
    },
  }
}

test('linked goal ids are scoped by organization AND resource identity', async () => {
  const db = fakeDb([{ goalId: 'goal-a' }, { goalId: 'goal-b' }])
  const ids = await resolveLinkedGoalIds('org-1', { type: 'agent', id: 'agent-9' }, db)

  assert.deepEqual(ids, ['goal-a', 'goal-b'])
  assert.deepEqual((db.calls[0] as { where: unknown }).where, {
    organizationId: 'org-1',
    resourceType: 'agent',
    resourceId: 'agent-9',
  })
})

test('a resource with no contribution resolves to an empty set', async () => {
  const ids = await resolveLinkedGoalIds('org-1', { type: 'flow', id: 'flow-3' }, fakeDb([]))
  assert.deepEqual(ids, [])
})

test('duplicate contribution rows collapse to a unique id set', async () => {
  const ids = await resolveLinkedGoalIds(
    'org-1',
    { type: 'agent', id: 'agent-9' },
    fakeDb([{ goalId: 'goal-a' }, { goalId: 'goal-a' }]),
  )
  assert.deepEqual(ids, ['goal-a'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/agents/__tests__/goals-plane.test.ts`
Expected: FAIL — cannot find module `@/lib/integrations/goals-port`

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/integrations/goals-port.ts`:

```ts
/**
 * Prisma-backed GoalsDataPort, plus the scoping query the plane loader uses to
 * decide which goals a resource may touch. Kept out of ./goals so the tool
 * client stays database-free and unit-testable.
 */

import { prisma } from '@/lib/prisma'
import { bucketKeyFor } from '@/lib/goals/refresh'
import { AGENT_DATAPOINT_ORIGIN } from '@/lib/goals/agent-tool-policy'
import type { AgentGoalView, GoalsDataPort } from '@/lib/integrations/goals'

export type GoalResource = { type: 'agent' | 'flow'; id: string }

/** The narrow slice of Prisma this module needs, so tests can pass a fake. */
type ContributionDb = {
  goalContribution: {
    findMany(args: {
      where: { organizationId: string; resourceType: string; resourceId: string }
      select?: unknown
    }): Promise<{ goalId: string }[]>
  }
}

/**
 * Every goal this resource is linked to. This is the ENTIRE authorization
 * input: the returned set becomes the client's reachable universe, so a bug
 * here is a scoping bug, not a display bug.
 */
export async function resolveLinkedGoalIds(
  organizationId: string,
  resource: GoalResource,
  db: ContributionDb = prisma as unknown as ContributionDb,
): Promise<string[]> {
  const rows = await db.goalContribution.findMany({
    where: {
      organizationId,
      resourceType: resource.type,
      resourceId: resource.id,
    },
    select: { goalId: true },
  })
  return [...new Set(rows.map((row) => row.goalId))]
}

export function prismaGoalsPort(organizationId: string): GoalsDataPort {
  const primaryMetric = async (goalId: string) =>
    prisma.goalMetric.findFirst({
      where: { organizationId, goalId },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, source: true, refreshIntervalHours: true },
    })

  return {
    async getGoal(goalId: string): Promise<AgentGoalView | null> {
      const goal = await prisma.goal.findFirst({
        where: { id: goalId, organizationId },
        select: {
          id: true, name: true, kind: true, unit: true, direction: true,
          startValue: true, targetValue: true, startAt: true, targetDate: true,
          recurrence: true, createdAt: true,
        },
      })
      if (!goal) return null
      const metric = await primaryMetric(goalId)
      return {
        ...goal,
        direction: goal.direction as 'increase' | 'decrease',
        primarySource: metric?.source ?? null,
        refreshIntervalHours: metric?.refreshIntervalHours ?? 24,
      }
    },

    async listDatapoints(goalId: string, limit: number) {
      const metric = await primaryMetric(goalId)
      if (!metric) return []
      return prisma.metricDatapoint.findMany({
        where: { organizationId, goalMetricId: metric.id },
        orderBy: { capturedAt: 'desc' },
        take: limit,
        select: { value: true, capturedAt: true },
      })
    },

    async writeDatapoint(goalId: string, value: number, capturedAt: Date) {
      const metric = await primaryMetric(goalId)
      if (!metric) throw new Error('This goal has no metric configured yet.')
      const bucketKey = bucketKeyFor(capturedAt)
      // Same upsert discipline as the sync path: one row per metric per UTC
      // day, never a double write. origin='assisted' inherits the existing
      // "AI-read" labeling with no UI change.
      await prisma.metricDatapoint.upsert({
        where: {
          goalMetricId_bucketKey: { goalMetricId: metric.id, bucketKey },
          organizationId,
        },
        create: {
          organizationId,
          goalMetricId: metric.id,
          value,
          capturedAt,
          bucketKey,
          origin: AGENT_DATAPOINT_ORIGIN,
        },
        update: { value, capturedAt, origin: AGENT_DATAPOINT_ORIGIN },
      })
    },
  }
}
```

Then in `src/features/agents/tool-planes.ts`:

1. Add imports near the other integration imports:

```ts
import { GoalsToolClient, goalsTools } from '@/lib/integrations/goals'
import { prismaGoalsPort, resolveLinkedGoalIds, type GoalResource } from '@/lib/integrations/goals-port'
```

2. Widen the signature at line 202:

```ts
export async function loadNativePlaneGroups(
  organizationId: string,
  options: { providers?: string[]; resource?: GoalResource } = {},
): Promise<ToolPlaneGroup[]> {
```

3. Append this block after the Email plane block, before the final `return groups`:

```ts
  // Sublime Goals — read/write on the goals THIS resource is linked to.
  // Absent (not empty) when nothing is linked, so an unlinked agent never sees
  // the tools. Authorization is decided here and baked into the client: it is
  // constructed with the resolved id set and has no query reaching past it.
  const goalsConn = BUILTIN_CONNECTORS.find((c) => c.providerId === 'sublime-goals')!
  if (selected(goalsConn) && options.resource) {
    try {
      const goalIds = await resolveLinkedGoalIds(organizationId, options.resource)
      if (goalIds.length) {
        groups.push(
          group(
            goalsConn,
            'sublime://goals',
            new GoalsToolClient(goalIds, prismaGoalsPort(organizationId)),
            goalsTools(),
          ),
        )
      }
    } catch (error) {
      apiLogger.warn('loadTools: Goals tool setup failed, skipping provider', {
        provider: 'sublime-goals',
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
```

`'sublime://goals'` is a synthetic serverUrl — the plane is in-process and `GoalsToolClient.executeTool` ignores the argument, exactly as `HttpToolClient` does.

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/agents/__tests__/goals-plane.test.ts`
Expected: PASS — 3 tests

Then confirm nothing else broke: `npx tsc --noEmit -p tsconfig.json`
Expected: no output

- [ ] **Step 5: Commit**

```bash
git add src/lib/integrations/goals-port.ts src/features/agents/tool-planes.ts src/features/agents/__tests__/goals-plane.test.ts
git commit -m "feat(goals): load the sublime-goals plane scoped to linked goals"
```

---

### Task 6: Thread the running resource through

**Files:**
- Modify: `src/features/agents/execute-agent.ts` (`loadTools` signature at line 240; the native call at line 275; the call site at line 621)
- Modify: `src/lib/flows/tool-catalog.ts` (`loadFlowToolCatalog` options and the native call at line 52)

**Interfaces:**
- Consumes: `loadNativePlaneGroups(organizationId, { providers, resource })` from Task 5
- Produces: no new exports — `loadFlowToolCatalog` gains an optional `resource?: GoalResource` in its existing options object

- [ ] **Step 1: Wire execute-agent**

In `src/features/agents/execute-agent.ts`, add `resource` to the `loadTools` options parameter (line 245):

```ts
async function loadTools(
  organizationId: string,
  providers: string[],
  ownerUserId?: string | null,
  query?: string,
  flowOptions?: { allowFlows?: boolean; flowIds?: string[]; resource?: GoalResource },
) {
```

Import the type at the top of the file, alongside the existing tool-plane imports:

```ts
import type { GoalResource } from '@/lib/integrations/goals-port'
```

Change the native plane call (line 275) to forward it:

```ts
  for (const group of await loadNativePlaneGroups(organizationId, {
    providers,
    resource: flowOptions?.resource,
  })) pushGroup(group)
```

At the call site (line 621), pass the running agent's identity:

```ts
    const { tools, bindings } = await loadTools(organizationId, providers, userId, toolQuery, {
      allowFlows: agentMetadata.allowFlows === true,
      flowIds: Array.isArray(agentMetadata.flowIds) ? agentMetadata.flowIds.map(String) : [],
      resource: { type: 'agent', id: agent.id },
    })
```

- [ ] **Step 2: Wire the flow tool catalog**

In `src/lib/flows/tool-catalog.ts`, add `resource` to `loadFlowToolCatalog`'s options and forward it (line 52):

```ts
export async function loadFlowToolCatalog(
  organizationId: string,
  options: {
    userId?: string
    takeConnections?: number
    takeTools?: number
    connectionIds?: string[]
    resource?: GoalResource
  } = {},
): Promise<FlowToolCatalogConnection[]> {
```

```ts
    wantPlane('native')
      ? loadNativePlaneGroups(organizationId, { resource: options.resource }).catch(
          () => [] as ToolPlaneGroup[],
        )
      : [],
```

Import the type alongside the existing imports:

```ts
import type { GoalResource } from '@/lib/integrations/goals-port'
```

Callers that omit `resource` keep today's behavior exactly: no resource means no goals group. The flow builder's tool picker is one such caller — a documented, accepted consequence in the spec.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: 0 failures. Baseline before this plan was 1872 tests / 1850 pass / 22 skipped; this plan adds 22 tests (4 + 7 + 5 + 3 + 3), so expect ~1894 total with 0 failures.

- [ ] **Step 5: Lint the touched files**

Run:
```bash
npx eslint src/lib/goals/agent-tool-policy.ts src/lib/integrations/goals.ts src/lib/integrations/goals-port.ts src/lib/connectors/registry.ts src/features/agents/tool-planes.ts src/features/agents/execute-agent.ts src/lib/flows/tool-catalog.ts
```
Expected: no output

- [ ] **Step 6: Commit**

```bash
git add src/features/agents/execute-agent.ts src/lib/flows/tool-catalog.ts
git commit -m "feat(goals): scope the goals plane to the running agent or flow"
```

---

## Known coverage limits

Stated plainly so a reviewer does not read "22 tests pass" as "everything is proven":

- **`goals-port.ts` has no unit test.** It is the only file that touches Prisma, and testing it honestly needs a real Postgres (see the QA database protocol in the `verify` skill). What *is* guarded: the origin value is pinned by a constant test in Task 1, and the scoping query's `where` clause is asserted in Task 5 against a fake. The upsert itself — that a same-day re-write replaces rather than duplicates — is covered only by the shared `@@unique(goalMetricId, bucketKey)` constraint and the sync path's existing tests.
- **`loadNativePlaneGroups` is not called in any test.** Task 5 tests `resolveLinkedGoalIds` directly; the `if (goalIds.length)` guard that suppresses the group is a one-line consequence of it, verified by reading rather than by execution.

Both are acceptable for this slice. Revisit if slice 2 turns the write path into a heavily-used surface.

## Verification

After Task 6, the plane exists but nothing selects it — no seed template declares a `goals` integration yet. That is slice 2's job, and it is the reason this plan ships no user-visible change.

To confirm the plane works end-to-end before slice 2, attach `goals` to any existing agent's integrations and link it to a goal via the contributions panel on the goal page, then run the agent and check its run log for `sublime-goals` tool calls. Do not add a seed template here — the catalogue is slice 2's spec.

## Out of Scope

- Goal-template ↔ agent bundle mapping and the goal-page deploy UI (slice 2)
- New goal-native seed templates (slice 2)
- `GoalNote` / agent annotations
- `record_contribution` — rejected in the spec; attribution is derived from run records
- Any change to `MetricDatapoint`, `GoalContribution`, or any other Prisma model
