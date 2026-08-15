/**
 * Route-handler drive for the Home strip's batched impact endpoint. Real
 * Postgres + seeded auth (`verify` skill): jsdom cannot prove the visibility
 * filter or the ids cap. Inert without TEST_DATABASE_URL.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any
  let visibleGoalId: string
  let personalOtherGoalId: string

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    const base = {
      organizationId: seeded.organizationId,
      kind: 'kpi',
      unit: 'count',
      direction: 'increase',
      startValue: 0,
      targetValue: 10,
      startAt: new Date('2026-07-01T00:00:00Z'),
      targetDate: new Date('2026-09-01T00:00:00Z'),
    }
    visibleGoalId = (await prisma.goal.create({ data: { ...base, name: 'Org goal' } })).id
    // A second member's PERSONAL goal: must be silently absent, never 403 —
    // even for an admin caller (goalReadWhere's admin branch still excludes
    // other users' personal goals).
    const other = await prisma.user.create({
      data: {
        supabaseId: crypto.randomUUID(),
        organizationId: seeded.organizationId,
        isActive: true,
        role: 'MEMBER',
      },
    })
    personalOtherGoalId = (
      await prisma.goal.create({
        data: { ...base, name: 'Someone else personal', ownerUserId: other.id },
      })
    ).id
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  const get = async (ids: string) => {
    const { GET } = await import('@/app/api/goals/impact/batch/route')
    const response = await GET(new NextRequest(`http://test/api/goals/impact/batch?ids=${ids}`))
    return { status: response.status, body: await response.json() }
  }

  test('returns zero-shape impact for a visible goal with no contributions', async () => {
    const { status, body } = await get(visibleGoalId)
    assert.equal(status, 200)
    assert.equal(body.impact[visibleGoalId].measured.runsCompleted, 0)
    assert.equal(body.impact[visibleGoalId].estimated.aiCostUsd, 0)
  })

  test('another user personal goal is absent from the response (never 403)', async () => {
    const { status, body } = await get(`${visibleGoalId},${personalOtherGoalId}`)
    assert.equal(status, 200)
    assert.ok(body.impact[visibleGoalId])
    assert.equal(body.impact[personalOtherGoalId], undefined)
  })

  test('more than 3 ids is a 400', async () => {
    const { status } = await get('a,b,c,d')
    assert.equal(status, 400)
  })

  test('empty ids is a 400', async () => {
    const { status } = await get('')
    assert.equal(status, 400)
  })
}
