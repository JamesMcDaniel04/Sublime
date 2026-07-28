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
/** Bounded like DATAPOINT_LIMIT so a busy goal cannot flood an agent's
 *  context. An agent deciding what to produce next needs the recent shape of
 *  the queue, not its whole history. */
export const WORK_LIMIT = 50

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

export type WriteWorkInput = {
  subject: string
  subjectRef: string | null
  produced: string
  body: string | null
  bodyFormat: 'markdown' | 'html'
  /** A name or email the agent read while producing. Resolved server-side; an
   *  unresolvable hint yields no assignee rather than an error. */
  assigneeHint: string | null
  /** Flat features the agent used to pick this subject. Null when it reported
   *  none — distinct from an empty object, which would mean "no features". */
  signals: Record<string, unknown> | null
  /** Set when this item is a probe against an active rule. */
  probeRuleId: string | null
}

export type GoalWorkItem = {
  id: string
  subject: string
  subjectRef: string | null
  produced: string
  disposition: string
  outcome: string
  assigneeUserId: string | null
  createdAt: Date
}

export type GoalsDataPort = {
  getGoal(goalId: string): Promise<AgentGoalView | null>
  listDatapoints(goalId: string, limit: number): Promise<{ value: number; capturedAt: Date }[]>
  writeDatapoint(goalId: string, value: number, capturedAt: Date): Promise<void>
  writeWork(goalId: string, input: WriteWorkInput): Promise<{ id: string; assigned: boolean }>
  listWork(goalId: string, limit: number, disposition?: string): Promise<GoalWorkItem[]>
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
        'Read the definition of a goal you are working toward: its name, target value, target date, unit, direction and recurrence. Call this first so you know what success means before doing anything else.',
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
        'Record a value for a goal you track manually or read with AI. Only works when nobody else owns the number — a goal wired to Stripe, a CRM, a warehouse or a URL is read automatically and will refuse this call. Recorded values are labeled AI-read.',
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
    {
      name: 'log_work',
      description:
        'Record ONE thing you produced toward this goal. Call it once per subject — one call per deal, lead or account, never one call summarizing a batch. The per-subject record is what lets the team see which work landed and what to stop producing.',
      inputSchema: {
        type: 'object',
        properties: {
          goalId,
          subject: {
            type: 'string',
            description:
              'Who or what this work is about, as a person would say it: "Acme Corp — deal 412".',
          },
          subjectRef: {
            type: 'string',
            description:
              'A stable id for the subject (the CRM record id). Supplying it stops you re-drafting the same subject while an earlier draft is still waiting on a human.',
          },
          produced: {
            type: 'string',
            description:
              'What you made, as a short noun phrase: "re-entry email", "buying-committee map".',
          },
          body: {
            type: 'string',
            description: 'The artifact itself, ready for a person to use.',
          },
          bodyFormat: {
            type: 'string',
            enum: ['markdown', 'html'],
            description: 'Defaults to markdown.',
          },
          assigneeHint: {
            type: 'string',
            description:
              'Name or email of the person who should act on it — usually the record owner. Unrecognized names are fine; the item goes to the unassigned pool rather than failing.',
          },
          signals: {
            type: 'object',
            description:
              'Why you picked THIS subject — the features you judged it on, as a flat object: {"daysCold": 21, "stage": "negotiation", "contacts": 3}. This is what lets the team learn which targeting works, so record the numbers you actually used rather than a summary.',
          },
          probeRuleId: {
            type: 'string',
            description:
              'Only when you are deliberately working a subject a stated rule tells you to skip, to test whether that rule still holds. Pass the rule id from your instructions.',
          },
        },
        required: ['subject', 'produced', 'body'],
      },
    },
    {
      name: 'list_work',
      description:
        "What you have already queued for this goal, newest first, with each item's disposition and outcome. Read it before producing: it stops you re-drafting something a human has not dealt with yet, and it shows what people skipped so you can stop producing that kind of thing.",
      inputSchema: {
        type: 'object',
        properties: {
          goalId,
          disposition: {
            type: 'string',
            enum: ['pending', 'used', 'edited', 'skipped'],
            description: 'Optional filter. Omit to see everything recent.',
          },
        },
        required: [],
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
      // Port returns newest-first; evaluateGoal wants oldest-first.
      const ordered: EvalPoint[] = [...points].reverse()
      // Same staleness window the goal detail API uses, so the agent sees the
      // number the dashboard shows rather than a second opinion.
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

    if (name === 'log_work') {
      const goal = await this.loadGoal(args.goalId)
      // Deliberately NO canWriteDatapoint check. That guard exists because a
      // system of record owns the NUMBER and a model's guess must never
      // overwrite it. Work has no system of record — this agent is its author
      // — so the allowlist is the wrong shape here and must not be applied.
      const subject = String(args.subject ?? '').trim()
      if (!subject) {
        throw new Error('subject is required — name who or what this work is about')
      }
      const produced = String(args.produced ?? '').trim()
      if (!produced) throw new Error('produced is required — name what you made')

      const rawSignals = args.signals
      if (
        rawSignals !== undefined &&
        rawSignals !== null &&
        (typeof rawSignals !== 'object' || Array.isArray(rawSignals))
      ) {
        throw new Error('signals must be a flat object of the features you judged this subject on')
      }

      const written = await this.port.writeWork(goal.id, {
        subject,
        subjectRef: args.subjectRef ? String(args.subjectRef) : null,
        produced,
        body: args.body === undefined || args.body === null ? null : String(args.body),
        bodyFormat: args.bodyFormat === 'html' ? 'html' : 'markdown',
        assigneeHint: args.assigneeHint ? String(args.assigneeHint) : null,
        signals: (rawSignals as Record<string, unknown> | undefined) ?? null,
        probeRuleId: args.probeRuleId ? String(args.probeRuleId) : null,
      })
      return {
        ok: true,
        id: written.id,
        goalId: goal.id,
        subject,
        assigned: written.assigned,
      }
    }

    if (name === 'list_work') {
      const goal = await this.loadGoal(args.goalId)
      const items = await this.port.listWork(
        goal.id,
        WORK_LIMIT,
        args.disposition ? String(args.disposition) : undefined,
      )
      return {
        goalId: goal.id,
        items: items.map((item) => ({
          id: item.id,
          subject: item.subject,
          subjectRef: item.subjectRef,
          produced: item.produced,
          disposition: item.disposition,
          outcome: item.outcome,
          assigned: item.assigneeUserId !== null,
          createdAt: item.createdAt.toISOString(),
        })),
      }
    }

    throw new Error(`Unknown goals tool: ${name}`)
  }
}
