import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveAssignee } from '../goals-port'

const members = [
  { id: 'u1', email: 'Dana@acme.com', name: 'Dana Reed' },
  { id: 'u2', email: 'sam@acme.com', name: 'Sam Diaz' },
]

test('an assignee hint matches a member by email, case-insensitively', () => {
  assert.equal(resolveAssignee('dana@acme.com', members), 'u1')
  assert.equal(resolveAssignee('  SAM@ACME.COM  ', members), 'u2')
})

test('an assignee hint matches a member by full name', () => {
  assert.equal(resolveAssignee('Dana Reed', members), 'u1')
  assert.equal(resolveAssignee('sam diaz', members), 'u2')
})

test('an unresolvable hint yields null rather than throwing', () => {
  // An agent that read a name off a CRM record must never fail its run
  // because that person is not a Sublime user.
  assert.equal(resolveAssignee('Someone Else', members), null)
  assert.equal(resolveAssignee(null, members), null)
  assert.equal(resolveAssignee('', members), null)
  assert.equal(resolveAssignee('   ', members), null)
})

test('an ambiguous name hint yields null rather than guessing', () => {
  // Routing to the wrong person is worse than routing to nobody: the
  // unassigned pool is visible and claimable, a mis-assignment is silent.
  const twins = [
    { id: 'u1', email: 'd1@acme.com', name: 'Dana Reed' },
    { id: 'u2', email: 'd2@acme.com', name: 'Dana Reed' },
  ]
  assert.equal(resolveAssignee('Dana Reed', twins), null)
})

test('email wins over name when both could match different people', () => {
  const tricky = [
    { id: 'u1', email: 'dana reed@acme.com', name: 'Sam Diaz' },
    { id: 'u2', email: 'other@acme.com', name: 'dana reed@acme.com' },
  ]
  assert.equal(resolveAssignee('dana reed@acme.com', tricky), 'u1')
})

test('members with no email or name are skipped rather than matching empty hints', () => {
  const sparse = [{ id: 'u1', email: null, name: null }]
  assert.equal(resolveAssignee('', sparse), null)
  assert.equal(resolveAssignee('anything', sparse), null)
})
