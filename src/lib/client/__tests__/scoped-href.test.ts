import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scopedHref, goalHref } from '../scoped-href'

test('scopedHref prefixes an app path with its scope', () => {
  assert.equal(scopedHref('all', '/flows'), '/g/all/flows')
  assert.equal(scopedHref('goal_abc', '/flows'), '/g/goal_abc/flows')
})

test('scopedHref preserves query strings and fragments', () => {
  assert.equal(scopedHref('goal_abc', '/agents?tab=runs'), '/g/goal_abc/agents?tab=runs')
})

test('scopedHref leaves unscoped and external paths alone', () => {
  // Settings is workspace-level, and an absolute URL is not ours to rewrite.
  assert.equal(scopedHref('goal_abc', '/settings'), '/settings')
  assert.equal(scopedHref('goal_abc', 'https://example.com'), 'https://example.com')
})

test('surfaces that never moved under /g are left alone', () => {
  // The list is closed rather than an exclusion list precisely so these do not
  // become /g/goal_abc/templates and 404. A route nobody scoped stays put.
  for (const path of ['/templates', '/templates/abc', '/skills/abc', '/connections']) {
    assert.equal(scopedHref('goal_abc', path), path)
  }
})

test('a scoped prefix followed by a query string still scopes', () => {
  assert.equal(scopedHref('goal_abc', '/agents?agent=1'), '/g/goal_abc/agents?agent=1')
})

test('opening a goal switches the lens rather than nesting under the current one', () => {
  // /goals/[id] folded into the goals surface, so /g/all/goals/xyz is a 404.
  // The helper encodes the same rule as the next.config.js redirect.
  assert.equal(scopedHref('all', '/goals/goal_xyz'), '/g/goal_xyz/goals')
  assert.equal(scopedHref('goal_abc', '/goals/goal_xyz'), '/g/goal_xyz/goals')
  assert.equal(goalHref('goal_xyz'), '/g/goal_xyz/goals')
})

test('a goal href keeps its query string', () => {
  assert.equal(scopedHref('all', '/goals/goal_xyz?import=1'), '/g/goal_xyz/goals?import=1')
})

test('/goals/new is a page, not a goal id', () => {
  // Without the exception this becomes /g/new/goals and the create page is
  // unreachable — the same ordering trap the redirect list has to avoid.
  assert.equal(scopedHref('goal_abc', '/goals/new'), '/g/goal_abc/goals/new')
})

test('scopedHref is idempotent', () => {
  // Double-prefixing is the predictable bug when a caller passes an href that
  // some other helper already scoped.
  assert.equal(scopedHref('goal_abc', '/g/goal_abc/flows'), '/g/goal_abc/flows')
})

test('the client and server all-scope sentinels agree', async () => {
  // They are separate constants on purpose — goal-scope.ts imports Prisma and
  // cannot be pulled into a client bundle — so nothing but this test stops
  // them drifting apart.
  const { ALL_SCOPE: clientAll } = await import('../scoped-href')
  const { ALL_SCOPE: serverAll } = await import('@/lib/server/goal-scope')
  assert.equal(clientAll, serverAll)
})
