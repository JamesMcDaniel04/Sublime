import { test } from 'node:test'
import assert from 'node:assert/strict'
import { goalReadWhere, ALL_SCOPE } from '../goal-scope'

test('goalReadWhere admits org goals, own personal goals, and restricted goals you belong to', () => {
  assert.deepEqual(goalReadWhere('user_1'), {
    OR: [
      { ownerUserId: null, access: 'workspace' },
      { ownerUserId: 'user_1' },
      { access: 'restricted', members: { some: { userId: 'user_1' } } },
    ],
  })
})

test('an admin sees every org goal including restricted ones', () => {
  assert.deepEqual(goalReadWhere('admin_1', { isAdmin: true }), {
    OR: [{ ownerUserId: null }, { ownerUserId: 'admin_1' }],
  })
})

test("an admin's ordinary list does not include other people's personal goals", () => {
  // Piece A: admin reach is elevated, never ambient. Reading a colleague's
  // personal goal is an explicit withElevatedAccess act, not something that
  // quietly happens because you opened the goals page. The admin clause admits
  // org goals (ownerUserId null) and the admin's OWN personal goals only.
  const where = goalReadWhere('admin_1', { isAdmin: true })
  assert.deepEqual(where.OR, [{ ownerUserId: null }, { ownerUserId: 'admin_1' }])
  assert.ok(!where.OR.some((clause) => 'members' in clause))
})

test('the all-scope sentinel is the literal "all"', () => {
  // The routing layer relies on this exact value; a rename would silently
  // turn /g/all/flows into a goal lookup for a goal named "all".
  assert.equal(ALL_SCOPE, 'all')
})
