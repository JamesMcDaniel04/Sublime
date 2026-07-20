import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { githubIssueActivity, githubCommitActivity, makeGithubActivitySource } from '../sources/github'
import { getActivitySource } from '../registry'

test('registry resolves the github source with backfill capability', () => {
  const source = getActivitySource('github')
  assert.ok(source)
  assert.equal(source!.capabilities.backfill, true)
})

test('issue payload → opened_issue; pull_request key flips to opened_pr', () => {
  const base = { number: 7, created_at: '2026-06-01T10:00:00Z', user: { login: 'dev1' }, title: 'Fix login', state: 'open' }
  const issue = githubIssueActivity('acme/app', base)!
  assert.equal(issue.action, 'opened_issue')
  assert.equal(issue.entityType, 'issue')
  assert.equal(issue.entityRef, 'acme/app#7')
  assert.equal(issue.dedupeKey, 'github:acme/app:issue:7')
  const pr = githubIssueActivity('acme/app', { ...base, pull_request: { url: 'x' } })!
  assert.equal(pr.action, 'opened_pr')
  assert.equal(pr.entityType, 'pull_request')
  assert.equal(pr.dedupeKey, 'github:acme/app:pr:7')
})

test('commit payload → pushed_commit with stable dedupe key; message truncated into newState', () => {
  const activity = githubCommitActivity('acme/app', {
    sha: 'abc123def4567890',
    author: { login: 'dev1' },
    commit: { author: { name: 'Dev One', date: '2026-06-02T09:00:00Z' }, message: 'ship it' },
  })!
  assert.equal(activity.action, 'pushed_commit')
  assert.equal(activity.entityRef, 'acme/app@abc123def456')
  assert.equal(activity.dedupeKey, 'github:acme/app:commit:abc123def4567890')
  assert.deepEqual(activity.newState, { message: 'ship it' })
})

test('malformed payloads map to null instead of throwing', () => {
  assert.equal(githubIssueActivity('acme/app', {}), null)
  assert.equal(githubIssueActivity('acme/app', { number: 1, created_at: 'not-a-date', user: { login: 'x' } }), null)
  assert.equal(githubCommitActivity('acme/app', {}), null)
})

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  let prisma: any
  let seeded: any
  let organizationId: string

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    organizationId = seeded.organizationId
    await prisma.nangoConnection.create({
      data: {
        organizationId, userId: seeded.userId, connectionId: 'conn-gh-1',
        providerConfigKey: 'github-app', provider: 'github', status: 'connected',
      },
    })
  })
  after(async () => { if (seeded) await seeded.cleanup() })

  test('backfill walks repos → issues → commits with cursors, tolerating per-repo failures', async () => {
    const ISSUE = { number: 1, created_at: '2026-06-01T10:00:00Z', user: { login: 'dev1' }, title: 'Bug', state: 'open' }
    const PR = { number: 2, created_at: '2026-06-01T11:00:00Z', user: { login: 'dev2' }, title: 'Feat', state: 'open', pull_request: { url: 'x' } }
    const COMMIT = { sha: 'abc123def4567890', author: { login: 'dev1' }, commit: { author: { name: 'D', date: '2026-06-02T09:00:00Z' }, message: 'ship' } }
    const proxy = async ({ endpoint }: { endpoint: string }) => {
      if (endpoint === '/user/repos') return { data: [{ full_name: 'acme/app' }, { full_name: 'acme/empty' }] }
      if (endpoint === '/repos/acme/app/issues') return { data: [ISSUE, PR] }
      if (endpoint === '/repos/acme/app/commits') return { data: [COMMIT] }
      if (endpoint === '/repos/acme/empty/issues') return { data: [] }
      if (endpoint === '/repos/acme/empty/commits') throw new Error('409 Git Repository is empty')
      throw new Error(`unexpected endpoint ${endpoint}`)
    }
    const source = makeGithubActivitySource(proxy as never)
    const batches: { events: unknown[]; nextCursor?: string }[] = []
    for await (const batch of source.backfill({ organizationId, connectionRef: 'conn-gh-1' }, '90d')) batches.push(batch)
    const actions = batches.flatMap((b) => b.events).map((e) => (e as { action: string }).action).sort()
    assert.deepEqual(actions, ['opened_issue', 'opened_pr', 'pushed_commit'])
    assert.equal(batches[batches.length - 1].nextCursor, undefined) // terminal batch carries no cursor
    assert.ok(batches.slice(0, -1).every((b) => typeof b.nextCursor === 'string')) // interior batches checkpoint
  })

  test('backfill yields nothing when no mirror row matches the connectionRef', async () => {
    const source = makeGithubActivitySource((async () => { throw new Error('must not be called') }) as never)
    const batches: unknown[] = []
    for await (const batch of source.backfill({ organizationId, connectionRef: 'missing' }, '90d')) batches.push(batch)
    assert.equal(batches.length, 0)
  })
}
