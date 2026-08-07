/**
 * Polling triggers — n8n's "new row in a sheet / new record in the CRM"
 * family. A poll-triggered flow names a READ tool call as its source; the
 * cron dispatcher runs the check on the configured interval, diffs the
 * result against the identities it has already seen (cursor state persisted
 * on Flow.metadata.pollState), and dispatches one run PER NEW ITEM with the
 * item as the trigger input.
 *
 * Pure module: the executor is injected, so the diff logic is unit-testable
 * without connections.
 */
import { createHash } from 'node:crypto'

export type PollTriggerConfig = {
  /** Portable connection id (nango:<capability> / native:<p> / mcp row id). */
  connectionId: string
  toolName: string
  /** JSON object string of tool arguments (literal — no run context exists yet). */
  args?: string
  /** Dotted path to the item list inside the tool result (auto-detected when omitted). */
  itemsPath?: string
  /** Dotted path WITHIN an item that identifies it (default 'id'; falls back to a content hash). */
  idPath?: string
}

export type PollState = {
  lastPollAt?: string
  /** Identities already dispatched, newest first (capped). */
  seen?: string[]
}

export const POLL_DEFAULT_INTERVAL_MINUTES = 15
export const POLL_MIN_INTERVAL_MINUTES = 5
export const POLL_SEEN_CAP = 500
export const POLL_MAX_NEW_ITEMS_PER_TICK = 10

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), value)
}

/** Parse the trigger's poll config; null when required parts are missing. */
export function pollConfigFrom(trigger: unknown): (PollTriggerConfig & { intervalMinutes: number }) | null {
  if (!isRecord(trigger) || trigger.type !== 'poll' || !isRecord(trigger.source)) return null
  const source = trigger.source
  const connectionId = typeof source.connectionId === 'string' ? source.connectionId.trim() : ''
  const toolName = typeof source.toolName === 'string' ? source.toolName.trim() : ''
  if (!connectionId || !toolName) return null
  const interval = Number(trigger.intervalMinutes)
  return {
    connectionId,
    toolName,
    ...(typeof source.args === 'string' ? { args: source.args } : {}),
    ...(typeof source.itemsPath === 'string' && source.itemsPath.trim() ? { itemsPath: source.itemsPath.trim() } : {}),
    ...(typeof source.idPath === 'string' && source.idPath.trim() ? { idPath: source.idPath.trim() } : {}),
    intervalMinutes: Number.isFinite(interval)
      ? Math.max(POLL_MIN_INTERVAL_MINUTES, Math.min(24 * 60, interval))
      : POLL_DEFAULT_INTERVAL_MINUTES,
  }
}

export function pollIsDue(state: PollState, intervalMinutes: number, now: Date): boolean {
  if (!state.lastPollAt) return true
  const last = Date.parse(state.lastPollAt)
  if (!Number.isFinite(last)) return true
  return now.getTime() - last >= intervalMinutes * 60_000
}

/** The list inside a tool result: explicit path › array › common list keys. */
export function pollItemsFrom(result: unknown, itemsPath?: string): unknown[] {
  const source = itemsPath ? readPath(result, itemsPath) : result
  if (Array.isArray(source)) return source
  if (isRecord(source)) {
    for (const key of ['items', 'records', 'results', 'data', 'rows', 'values']) {
      const candidate = source[key]
      if (Array.isArray(candidate)) return candidate
    }
  }
  return []
}

/** Stable identity for one item: idPath value when present, else content hash. */
export function pollIdentityOf(item: unknown, idPath = 'id'): string {
  const explicit = readPath(item, idPath)
  if (explicit !== undefined && explicit !== null && explicit !== '') return `id:${String(explicit)}`
  return `hash:${createHash('sha1').update(JSON.stringify(item) ?? 'null').digest('hex')}`
}

/**
 * Diff a poll result against prior state. First poll BASELINES (records
 * identities, dispatches nothing) so connecting a source with 5 000 existing
 * rows doesn't fire 5 000 runs.
 */
export function diffPollResult(
  result: unknown,
  state: PollState,
  config: Pick<PollTriggerConfig, 'itemsPath' | 'idPath'>,
  now: Date,
): { newItems: unknown[]; nextState: PollState } {
  const items = pollItemsFrom(result, config.itemsPath)
  const identities = items.map((item) => pollIdentityOf(item, config.idPath ?? 'id'))
  const seen = new Set(state.seen ?? [])
  const isBaseline = state.lastPollAt === undefined && (state.seen?.length ?? 0) === 0
  const newItems: unknown[] = []
  const newIdentities: string[] = []
  if (!isBaseline) {
    items.forEach((item, index) => {
      if (seen.has(identities[index])) return
      if (newItems.length >= POLL_MAX_NEW_ITEMS_PER_TICK) return
      newItems.push(item)
      newIdentities.push(identities[index])
    })
  }
  const nextSeen = Array.from(new Set([...identities, ...(state.seen ?? [])])).slice(0, POLL_SEEN_CAP)
  return {
    newItems,
    nextState: { lastPollAt: now.toISOString(), seen: nextSeen },
  }
}
