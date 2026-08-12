import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Plan } from '@/generated/prisma/client'
import {
  entitlementPlanFor,
  isGrandfatheredOrganization,
} from '../entitlements'

test('pre-launch workspaces receive enterprise entitlements without a backfill marker', () => {
  const organization = {
    plan: Plan.TRIAL,
    createdAt: new Date('2026-07-19T20:30:59.000Z'),
    grandfatheredAt: null,
  }
  assert.equal(isGrandfatheredOrganization(organization), true)
  assert.equal(entitlementPlanFor(organization), Plan.ENTERPRISE)
})

test('new unpaid workspaces are not grandfathered', () => {
  const organization = {
    plan: Plan.TRIAL,
    createdAt: new Date('2026-07-19T20:31:01.000Z'),
    grandfatheredAt: null,
  }
  assert.equal(isGrandfatheredOrganization(organization), false)
  assert.equal(entitlementPlanFor(organization), Plan.TRIAL)
})

test('a durable marker always grants enterprise entitlements', () => {
  const organization = {
    plan: Plan.TRIAL,
    createdAt: new Date('2026-07-20T00:00:00.000Z'),
    grandfatheredAt: new Date('2026-07-20T00:01:00.000Z'),
  }
  assert.equal(isGrandfatheredOrganization(organization), true)
  assert.equal(entitlementPlanFor(organization), Plan.ENTERPRISE)
})

test('the cutoff governs billing only — no user-level authorization derives from it', async () => {
  // Guards the fix in 20260812010000_backfill_legacy_admin_role: a user's role
  // must never again be computed from createdAt, because anything that can set
  // an old createdAt (import, restore, seed) would then mint an admin.
  const source = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../entitlements.ts', import.meta.url), 'utf8'))
  assert.equal(/export function isLegacyPlatformUser/.test(source), false)
  assert.equal(/'ADMIN'|"ADMIN"/.test(source), false)
})
