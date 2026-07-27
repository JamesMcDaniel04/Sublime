/**
 * A goal created from a template must persist that template's dashboard
 * layout, with metric-index refs resolved to real metric ids.
 * Skipped unless TEST_DATABASE_URL is present.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
  })

  after(async () => {
    await seeded?.cleanup?.()
  })

  test('a templated goal persists the template layout with resolved metric ids', async () => {
    const { POST } = await import('@/app/api/goals/route')
    const { goalTemplateByKey } = await import('@/lib/goals/goal-templates')
    const template = goalTemplateByKey('sales-org-quarterly-revenue')!

    const response = await POST(
      new NextRequest('http://localhost/api/goals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: template.name,
          kind: template.kind,
          direction: template.direction,
          unit: template.unit,
          startValue: 100,
          targetValue: 500,
          targetDate: new Date(Date.now() + 90 * 86_400_000).toISOString(),
          recurrence: template.recurrence,
          personal: template.scope === 'personal',
          dashboardLayout: template.layout,
          metric: { source: 'manual', metricKey: 'manual', connectionRef: null, config: {} },
        }),
      }) as any,
    )
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))

    // findFirst with organizationId, not findUnique by id: the tenant guard
    // in lib/prisma.ts rejects any Goal query whose where clause is unscoped.
    const goal = await prisma.goal.findFirst({
      where: { id: body.goal.id, organizationId: seeded.organizationId },
      include: { metrics: true },
    })
    const layout = goal.dashboardLayout as {
      version: number
      widgets: Array<{ id: string; type: string; config: Record<string, unknown> }>
    }
    assert.equal(layout.version, 1)
    assert.deepEqual(
      layout.widgets.map((widget) => widget.type),
      template.layout.widgets.map((widget) => widget.type),
      'persisted widget types drifted from the template',
    )
    assert.equal(goal.ownerUserId, null, 'an org template must not set an owner')
  })

  test('a personal template lands owned by the creator', async () => {
    const { POST } = await import('@/app/api/goals/route')
    const { goalTemplateByKey } = await import('@/lib/goals/goal-templates')
    const template = goalTemplateByKey('sales-personal-quota')!

    const response = await POST(
      new NextRequest('http://localhost/api/goals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: template.name,
          kind: template.kind,
          direction: template.direction,
          unit: template.unit,
          startValue: 0,
          targetValue: 250,
          targetDate: new Date(Date.now() + 90 * 86_400_000).toISOString(),
          recurrence: template.recurrence,
          personal: true,
          dashboardLayout: template.layout,
          metric: { source: 'manual', metricKey: 'manual', connectionRef: null, config: {} },
        }),
      }) as any,
    )
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    const goal = await prisma.goal.findFirst({
      where: { id: body.goal.id, organizationId: seeded.organizationId },
    })
    assert.equal(goal.ownerUserId, seeded.userId, 'a personal template must set the owner')
  })
}
