import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Plan } from '@prisma/client'
import {
  entitlementPlanFor,
  isGrandfatheredOrganization,
  isLegacyPlatformUser,
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

test('only identities that existed at launch receive the super-admin fallback', () => {
  assert.equal(isLegacyPlatformUser({ createdAt: new Date('2026-07-19T20:30:59.000Z') }), true)
  assert.equal(isLegacyPlatformUser({ createdAt: new Date('2026-07-19T20:31:01.000Z') }), false)
})
