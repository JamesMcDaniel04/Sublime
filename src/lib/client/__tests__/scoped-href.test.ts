import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scopedHref } from '../scoped-href'

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
