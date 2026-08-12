import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Plan, type UserRole } from '@/generated/prisma/client'
import { can, denialReason, type Actor } from '../permissions'
import { isPlatformOwnerEmail } from '../platform-owner'
import { isPlatformOperator } from '../platform-roles'

const actor = (over: Partial<Actor> = {}): Actor => ({
  userId: 'u1',
  role: 'MEMBER' as UserRole,
  plan: Plan.TRIAL,
  ...over,
})

// ── The union that grants the tier ───────────────────────────────────────────

test('the tier needs BOTH an operator role and an internal workspace', () => {
  assert.equal(isPlatformOperator('operator', 'internal'), true)
  // Either half missing is a denial — this is the property that makes moving
  // someone to a customer workspace revoke their access with no flag to clear.
  assert.equal(isPlatformOperator('operator', 'customer'), false)
  assert.equal(isPlatformOperator('operator', 'partner'), false)
  assert.equal(isPlatformOperator('staff', 'internal'), false)
  assert.equal(isPlatformOperator(null, 'internal'), false)
})

test('staff is a marker, not a grant', () => {
  // If staff carried rights, every employee could read every tenant.
  assert.equal(can(actor({ platformRole: 'staff', orgKind: 'internal' }), 'platform:administer'), false)
})

test('unknown or mis-cased role values never grant the tier', () => {
  for (const value of ['Operator', 'OPERATOR', 'admin', 'owner', '', ' operator']) {
    assert.equal(isPlatformOperator(value, 'internal'), false, `granted for ${JSON.stringify(value)}`)
  }
})

// ── The owner identity root ──────────────────────────────────────────────────

test('the owner holds the tier by identity, independent of both columns', () => {
  // The point of the owner branch: it survives its own database being wrong.
  assert.equal(can(actor({ email: 'hello@estimoto.io' }), 'platform:administer'), true)
  assert.equal(
    can(actor({ email: 'hello@estimoto.io', platformRole: null, orgKind: 'customer' }), 'platform:administer'),
    true,
  )
})

test('owner matching ignores casing and surrounding whitespace', () => {
  assert.equal(isPlatformOwnerEmail('  HELLO@Estimoto.io '), true)
})

test('an absent email is never the owner', () => {
  // Guards the failure mode where a bare `===` would make every emailless
  // actor match an undefined entry.
  assert.equal(isPlatformOwnerEmail(null), false)
  assert.equal(isPlatformOwnerEmail(undefined), false)
  assert.equal(isPlatformOwnerEmail(''), false)
  assert.equal(can(actor(), 'platform:administer'), false)
})

test('a lookalike address is not the owner', () => {
  for (const email of ['hello@estimoto.io.evil.com', 'xhello@estimoto.io', 'hello@estimoto.iox']) {
    assert.equal(isPlatformOwnerEmail(email), false, `matched ${email}`)
  }
})

// ── Isolation from the workspace axes ────────────────────────────────────────

test('no workspace role and no plan can reach the platform tier', () => {
  for (const plan of [Plan.TRIAL, Plan.ENTERPRISE]) {
    for (const role of ['ADMIN', 'MEMBER'] as UserRole[]) {
      assert.equal(can(actor({ role, plan }), 'platform:administer'), false, `${role}/${plan}`)
    }
  }
})

test('holding the platform tier grants nothing on the workspace axes', () => {
  // An operator is not thereby a workspace admin — the axes stay independent,
  // so the console cannot be used to escalate inside a tenant.
  const operator = actor({ platformRole: 'operator', orgKind: 'internal', role: 'MEMBER' as UserRole })
  assert.equal(can(operator, 'member:manage'), false)
  assert.equal(can(operator, 'settings:workspace'), false)
  assert.equal(can(operator, 'billing:manage'), false)
})

test('a denied platform capability reports role, never plan', () => {
  // Reporting 'plan' would render "upgrade your plan" for something no
  // workspace can buy.
  assert.equal(denialReason(actor({ plan: Plan.ENTERPRISE }), 'platform:administer'), 'role')
  assert.equal(denialReason(actor({ platformRole: 'operator', orgKind: 'internal' }), 'platform:administer'), null)
})
