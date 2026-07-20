/**
 * GitHub ActivitySource — historical issues/PRs/commits through the Nango
 * proxy (credentials never touch this process; same seam as
 * src/lib/nango/delivery.ts). connectionRef is the Nango connection id; the
 * mirror row supplies the providerConfigKey. The GitHub issues endpoint
 * returns PRs too (they carry a pull_request key), so the walk is two phases
 * per repo: issues (issues + PRs), then commits.
 */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { getNangoClient } from '@/lib/nango/client'
import type { NangoProxy } from '@/lib/nango/delivery'
import {
  windowStart,
  type ActivitySource,
  type BackfillBatch,
  type BackfillWindow,
  type NormalizedActivity,
  type SourceContext,
} from '../types'

const PAGE_SIZE = 100
const MAX_REPOS = 10
const CALL_TIMEOUT_MS = 30_000

type GithubCursor = { repos: string[]; repoIndex: number; phase: 'issues' | 'commits'; page: number }

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer)) as Promise<T>
}

function defaultProxy(): NangoProxy {
  const nango = getNangoClient()
  return (args) =>
    withTimeout(nango.proxy(args as never) as Promise<{ data: unknown }>, CALL_TIMEOUT_MS, `GitHub ${args.endpoint}`)
}

export function githubIssueActivity(repo: string, item: Record<string, unknown>): NormalizedActivity | null {
  const number = typeof item.number === 'number' ? item.number : null
  const createdAt = typeof item.created_at === 'string' ? new Date(item.created_at) : null
  const actor = (item.user as { login?: unknown } | undefined)?.login
  if (number === null || !createdAt || Number.isNaN(createdAt.getTime()) || typeof actor !== 'string') return null
  const isPr = Boolean(item.pull_request)
  return {
    source: 'github',
    actorRef: actor,
    action: isPr ? 'opened_pr' : 'opened_issue',
    entityType: isPr ? 'pull_request' : 'issue',
    entityRef: `${repo}#${number}`,
    entityName: typeof item.title === 'string' ? item.title.slice(0, 200) : null,
    businessContext: { repo, state: typeof item.state === 'string' ? item.state : 'unknown' },
    occurredAt: createdAt,
    dedupeKey: `github:${repo}:${isPr ? 'pr' : 'issue'}:${number}`,
  }
}

export function githubCommitActivity(repo: string, item: Record<string, unknown>): NormalizedActivity | null {
  const sha = typeof item.sha === 'string' ? item.sha : null
  const commit = item.commit as { author?: { name?: unknown; date?: unknown }; message?: unknown } | undefined
  const date = typeof commit?.author?.date === 'string' ? new Date(commit.author.date) : null
  if (!sha || !date || Number.isNaN(date.getTime())) return null
  const login = (item.author as { login?: unknown } | undefined)?.login
  const fallbackName = typeof commit?.author?.name === 'string' ? commit.author.name : 'unknown'
  return {
    source: 'github',
    actorRef: typeof login === 'string' ? login : fallbackName,
    action: 'pushed_commit',
    entityType: 'commit',
    entityRef: `${repo}@${sha.slice(0, 12)}`,
    businessContext: { repo },
    newState: { message: typeof commit?.message === 'string' ? commit.message.slice(0, 200) : '' },
    occurredAt: date,
    dedupeKey: `github:${repo}:commit:${sha}`,
  }
}

async function resolveConnection(ctx: SourceContext): Promise<{ connectionId: string; providerConfigKey: string } | null> {
  return prisma.nangoConnection.findFirst({
    where: { organizationId: ctx.organizationId, connectionId: ctx.connectionRef },
    select: { connectionId: true, providerConfigKey: true },
  })
}

export function makeGithubActivitySource(proxyOverride?: NangoProxy): ActivitySource {
  return {
    source: 'github',
    capabilities: { backfill: true, webhooks: false, incrementalSync: false },
    async *backfill(ctx: SourceContext, window: BackfillWindow, cursor?: string): AsyncIterable<BackfillBatch> {
      const connection = await resolveConnection(ctx)
      if (!connection) return
      const proxy = proxyOverride ?? defaultProxy()
      const call = (endpoint: string, params: Record<string, string | number>) =>
        proxy({ method: 'GET', endpoint, connectionId: connection.connectionId, providerConfigKey: connection.providerConfigKey, params })
      const since = windowStart(window, new Date())
      const sinceParam: Record<string, string> = since ? { since: since.toISOString() } : {}

      let state: GithubCursor
      if (cursor) {
        state = JSON.parse(cursor) as GithubCursor
      } else {
        const response = await call('/user/repos', { sort: 'pushed', per_page: MAX_REPOS })
        const repos = (Array.isArray(response.data) ? response.data : [])
          .map((repo) => (repo as { full_name?: unknown }).full_name)
          .filter((name): name is string => typeof name === 'string')
          .slice(0, MAX_REPOS)
        state = { repos, repoIndex: 0, phase: 'issues', page: 1 }
      }

      while (state.repoIndex < state.repos.length) {
        const repo = state.repos[state.repoIndex]
        let rawCount = 0
        let events: NormalizedActivity[] = []
        try {
          const endpoint = state.phase === 'issues' ? `/repos/${repo}/issues` : `/repos/${repo}/commits`
          const params =
            state.phase === 'issues'
              ? { state: 'all', per_page: PAGE_SIZE, page: state.page, ...sinceParam }
              : { per_page: PAGE_SIZE, page: state.page, ...sinceParam }
          const response = await call(endpoint, params)
          const items = Array.isArray(response.data) ? (response.data as Record<string, unknown>[]) : []
          rawCount = items.length
          events = items
            .map((item) => (state.phase === 'issues' ? githubIssueActivity(repo, item) : githubCommitActivity(repo, item)))
            .filter((event): event is NormalizedActivity => event !== null)
        } catch (error) {
          // Per-repo tolerance: an empty repo 409s on /commits, a lost-access
          // repo 404s — skip the phase rather than failing the whole backfill.
          apiLogger.warn('github backfill: page fetch failed, skipping phase', {
            repo,
            phase: state.phase,
            error: error instanceof Error ? error.message : String(error),
          })
          rawCount = 0
        }
        state =
          rawCount === PAGE_SIZE
            ? { ...state, page: state.page + 1 }
            : state.phase === 'issues'
              ? { ...state, phase: 'commits', page: 1 }
              : { ...state, repoIndex: state.repoIndex + 1, phase: 'issues', page: 1 }
        const done = state.repoIndex >= state.repos.length
        yield { events, ...(done ? {} : { nextCursor: JSON.stringify(state) }) }
      }
    },
    async handleEvent() {
      return []
    },
    async incrementalSync() {
      return []
    },
  }
}

export const githubActivitySource = makeGithubActivitySource()
