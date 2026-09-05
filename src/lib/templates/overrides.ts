/**
 * Deploy-time template customization.
 *
 * A template is a starting point, not a contract: the detail page lets a
 * user rewrite the name, description, instructions, model, or schedule
 * BEFORE deploying, and sends the edited fields here as `overrides`. The
 * recipe itself (seed or community row) is still re-read server-side — an
 * override can only replace the free-text and scheduling fields a user could
 * set on a hand-built agent anyway, never the graph, tool bindings, or
 * integration requirements the trusted recipe declares.
 *
 * Pure so it unit-tests without a database and so the provision route and
 * the detail page agree on exactly which fields are customizable.
 */
import { z } from 'zod'
import type { AgentSchedule } from '@/lib/scheduling/due'

export const MAX_OVERRIDE_NAME = 120
export const MAX_OVERRIDE_DESCRIPTION = 2_000
export const MAX_OVERRIDE_INSTRUCTIONS = 40_000

const scheduleOverrideSchema = z.object({
  type: z.enum(['manual', 'hourly', 'daily', 'weekly', 'cron', 'once']),
  time: z.string().max(10).default(''),
  cron: z.string().max(120).default(''),
  timezone: z.string().max(80).default('UTC'),
  runAt: z.string().max(10).optional(),
  isActive: z.boolean().default(true),
})

export const templateOverridesSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_OVERRIDE_NAME).optional(),
    description: z.string().trim().max(MAX_OVERRIDE_DESCRIPTION).optional(),
    instructions: z.string().trim().min(1).max(MAX_OVERRIDE_INSTRUCTIONS).optional(),
    // Any id the runtime can route (model-runner.ts falls back across
    // endpoints); the agents route accepts the same free string.
    model: z.string().trim().min(1).max(100).optional(),
    schedule: scheduleOverrideSchema.optional(),
  })
  .strict()

export type TemplateOverrides = z.infer<typeof templateOverridesSchema>

/** A normalized override schedule: a cron cadence needs a cron, a manual one is inert. */
export function overrideSchedule(schedule: NonNullable<TemplateOverrides['schedule']>): AgentSchedule {
  if (schedule.type === 'manual') {
    return { type: 'manual', time: '', cron: '', timezone: schedule.timezone || 'UTC', isActive: false }
  }
  return {
    type: schedule.type,
    time: schedule.time ?? '',
    cron: schedule.cron ?? '',
    timezone: schedule.timezone || 'UTC',
    // runAt only means something for a one-time run; carrying it on a
    // recurring schedule would mislead anything that reads it back.
    ...(schedule.type === 'once' && schedule.runAt ? { runAt: schedule.runAt } : {}),
    isActive: schedule.isActive !== false,
  }
}

/** One cron field: `*`, `*\/n`, `a`, `a-b`, or a comma list of those — the grammar the scheduler's matcher understands. */
function validCronField(field: string, min: number, max: number): boolean {
  const inRange = (raw: string) => /^\d+$/.test(raw) && Number(raw) >= min && Number(raw) <= max
  return field.split(',').every((part) => {
    if (part === '*') return true
    if (part.startsWith('*/')) return /^\d+$/.test(part.slice(2)) && Number(part.slice(2)) > 0
    if (part.includes('-')) {
      const [lo, hi, ...rest] = part.split('-')
      return rest.length === 0 && inRange(lo) && inRange(hi) && Number(lo) <= Number(hi)
    }
    return inRange(part)
  })
}

/** Whether a five-field cron expression is one the scheduler (lib/scheduling/due.ts) can match. */
export function isValidCron(expression: string): boolean {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const [minute, hour, dom, month, dow] = fields
  return validCronField(minute, 0, 59) && validCronField(hour, 0, 23) && validCronField(dom, 1, 31)
    && validCronField(month, 1, 12) && validCronField(dow, 0, 6)
}

/** "HH:MM" on a 24-hour clock. */
export function isValidTime(time: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(time)
  return Boolean(match) && Number(match![1]) <= 23 && Number(match![2]) <= 59
}

/** "YYYY-MM-DD" naming a real calendar day (rejects 2026-02-31). */
export function isValidCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/**
 * Refuse a schedule that would be persisted but could never fire correctly:
 * a cron the matcher cannot parse, a time that is not on the clock, or a
 * one-time date that does not exist. The provision route writes the
 * schedule straight onto the agent and the flow trigger, so this is the
 * only gate before it goes live.
 */
export function validateOverrides(overrides: TemplateOverrides): string | null {
  const schedule = overrides.schedule
  if (!schedule) return null
  if (schedule.type === 'cron') {
    if (!schedule.cron.trim()) return 'A custom schedule needs a cron expression.'
    if (!isValidCron(schedule.cron)) return 'That cron expression is not valid: use five fields (minute hour day-of-month month day-of-week).'
  }
  if ((schedule.type === 'daily' || schedule.type === 'weekly' || schedule.type === 'once') && !isValidTime(schedule.time)) {
    return 'A daily, weekly, or one-time schedule needs a time in HH:MM.'
  }
  if (schedule.type === 'once' && !isValidCalendarDate(schedule.runAt ?? '')) return 'A one-time schedule needs a real calendar date (YYYY-MM-DD).'
  return null
}

export type OverridableRecipe = {
  name: string
  description: string
  instructions: string
  model?: string
  schedule: AgentSchedule
}

/**
 * Merge overrides onto the trusted recipe fields. Only present keys replace;
 * an empty description is an explicit clear (the field is optional in the
 * schema, so its presence is the signal). Returns the field names that were
 * actually changed so the caller can record them on the provisioned row.
 */
export function applyTemplateOverrides<T extends OverridableRecipe>(
  recipe: T,
  overrides: TemplateOverrides | undefined,
): { recipe: T; applied: Array<keyof TemplateOverrides> } {
  if (!overrides) return { recipe, applied: [] }
  const applied: Array<keyof TemplateOverrides> = []
  const next = { ...recipe }
  if (overrides.name !== undefined && overrides.name !== recipe.name) { next.name = overrides.name; applied.push('name') }
  if (overrides.description !== undefined && overrides.description !== recipe.description) { next.description = overrides.description; applied.push('description') }
  if (overrides.instructions !== undefined && overrides.instructions !== recipe.instructions) { next.instructions = overrides.instructions; applied.push('instructions') }
  if (overrides.model !== undefined && overrides.model !== recipe.model) { next.model = overrides.model; applied.push('model') }
  if (overrides.schedule !== undefined) {
    const schedule = overrideSchedule(overrides.schedule)
    if (!sameSchedule(schedule, recipe.schedule)) { next.schedule = schedule; applied.push('schedule') }
  }
  return { recipe: next, applied }
}

/** Field-wise, so key order and absent-vs-empty optional fields never register as an edit. */
function sameSchedule(a: AgentSchedule, b: AgentSchedule): boolean {
  return a.type === b.type
    && (a.time ?? '') === (b.time ?? '')
    && (a.cron ?? '') === (b.cron ?? '')
    && (a.timezone || 'UTC') === (b.timezone || 'UTC')
    && (a.runAt ?? '') === (b.runAt ?? '')
    && Boolean(a.isActive) === Boolean(b.isActive)
}
