/**
 * End-to-end verification of the day-one ROI Plan 1 pipeline.
 *
 * Drives the REAL code path: adapter normalizers -> persistActivity (the
 * production ledger, including its Prisma.JsonNull handling) ->
 * recomputeOrgBaselines -> process_baselines rows. Then hand-checks the
 * numbers against SQL counts.
 */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
process.env.DIRECT_URL = process.env.TEST_DATABASE_URL

import assert from 'node:assert/strict'

async function main() {

  const { prisma } = await import('@/lib/prisma')
  const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
  const { persistActivity } = await import('@/lib/activity/ledger')
  const { hubspotStageChangeActivities, hubspotEngagementActivity, hubspotDealActivity } = await import(
    '@/lib/activity/sources/hubspot'
  )
  const { githubPullLifecycleActivity, githubIssueActivity } = await import('@/lib/activity/sources/github')
  const { recomputeOrgBaselines } = await import('@/lib/baselines/persist')

  const seeded = await seedTestOrg(prisma)
  const organizationId: string = seeded.organizationId
  console.log(`seeded org ${organizationId}\n`)

  try {
    // ── Build events through the real normalizers ──────────────────────────
    const events = []

    // A deal that moved through four stages, regressing once (rework).
    const stageHistory = [
      { value: 'closedwon', timestamp: '1785542400000' }, // 2026-08-01
      { value: 'qualifiedtobuy', timestamp: '1785456000000' }, // 2026-07-31  <- back to a left state
      { value: 'contractsent', timestamp: '1785369600000' }, // 2026-07-30
      { value: 'qualifiedtobuy', timestamp: '1785283200000' }, // 2026-07-29
    ]
    const deal = {
      id: 'deal_v1',
      properties: {
        dealname: 'Verification deal',
        dealstage: 'closedwon',
        createdate: '2026-07-29T00:00:00Z',
        hubspot_owner_id: 'owner_1',
      },
      propertiesWithHistory: { dealstage: stageHistory },
    }
    const created = hubspotDealActivity(deal)
    if (created) events.push(created)
    events.push(...hubspotStageChangeActivities(deal))

    // Point events: logged emails from two different owners.
    for (let i = 0; i < 6; i += 1) {
      const email = hubspotEngagementActivity('email', {
        id: `eng_v${i}`,
        properties: {
          hs_timestamp: new Date(Date.UTC(2026, 6, 10 + i)).toISOString(),
          hubspot_owner_id: i % 2 === 0 ? 'owner_1' : 'owner_2',
        },
      })
      if (email) events.push(email)
    }

    // A completed task (transition) and a GitHub PR merge (transition).
    const task = hubspotEngagementActivity('task', {
      id: 'task_v1',
      properties: {
        hs_timestamp: '2026-07-20T00:00:00Z',
        hubspot_owner_id: 'owner_1',
        hs_task_status: 'COMPLETED',
        hs_task_type: 'TODO',
      },
    })
    if (task) events.push(task)

    const pr = {
      number: 7,
      title: 'Verification PR',
      user: { login: 'alice' },
      pull_request: {},
      state: 'closed',
      created_at: '2026-07-15T00:00:00Z',
      closed_at: '2026-07-18T00:00:00Z',
      merged_at: '2026-07-18T00:00:00Z',
    }
    const opened = githubIssueActivity('acme/api', pr)
    if (opened) events.push(opened)
    const merged = githubPullLifecycleActivity('acme/api', pr)
    if (merged) events.push(merged)

    const { created: persisted, duplicates } = await persistActivity(organizationId, 'backfill', events)
    console.log(`persisted ${persisted.length} events (${duplicates} duplicates)\n`)

    // ── Check 1: previousState population, with the JsonNull trap ──────────
    console.log('=== previousState by action ===')
    const rows = await prisma.$queryRawUnsafe<
      { action: string; events: bigint; with_prev_naive: bigint; with_prev_correct: bigint }[]
    >(
      `SELECT action,
              count(*) AS events,
              count(*) FILTER (WHERE "previousState" IS NOT NULL) AS with_prev_naive,
              count(*) FILTER (WHERE "previousState" IS NOT NULL
                                 AND "previousState" <> 'null'::jsonb) AS with_prev_correct
         FROM activity_events
        WHERE "organizationId" = $1::uuid
        GROUP BY action
        ORDER BY action`,
      organizationId,
    )
    for (const row of rows) {
      console.log(
        `  ${row.action.padEnd(20)} events=${row.events}  naive=${row.with_prev_naive}  correct=${row.with_prev_correct}`,
      )
    }

    const TRANSITION_ACTIONS = new Set(['deal_stage_changed', 'completed_task', 'merged_pr', 'closed_pr'])
    let jsonNullTrapConfirmed = false
    for (const row of rows) {
      if (TRANSITION_ACTIONS.has(row.action)) {
        assert.equal(row.with_prev_correct, row.events, `${row.action} must populate previousState on every row`)
      } else {
        assert.equal(row.with_prev_correct, 0n, `${row.action} is a point event and must not carry previousState`)
        if (row.with_prev_naive > 0n) jsonNullTrapConfirmed = true
      }
    }
    console.log(
      `\nPhase 1 criterion: PASS` +
        (jsonNullTrapConfirmed
          ? "\n  (JsonNull trap CONFIRMED: naive IS NOT NULL matches point events too — the <> 'null'::jsonb guard is required)"
          : '\n  (JsonNull trap did not appear on this data)'),
    )

    // ── Check 2: baselines match hand-counted SQL ─────────────────────────
    const result = await recomputeOrgBaselines(organizationId, { now: new Date('2026-08-05T00:00:00Z') })
    console.log(`\nrecompute: ${result.baselines} baselines from ${result.events} events\n`)

    console.log('=== process_baselines ===')
    const baselines = await prisma.processBaseline.findMany({
      where: { organizationId },
      orderBy: { confidence: 'desc' },
    })
    for (const b of baselines) {
      console.log(
        `  ${b.source}/${b.action}`.padEnd(34) +
          `vol=${String(b.volume).padStart(2)} actors=${b.distinctActors} ` +
          `period=${b.periodDays === null ? 'null' : b.periodDays.toFixed(1)} ` +
          `cycle=${b.medianCycleTimeHours === null ? 'null' : b.medianCycleTimeHours.toFixed(0) + 'h'} ` +
          `rework=${b.reworkRate === null ? 'null' : b.reworkRate} ` +
          `conf=${b.confidence.toFixed(3)} mins=${b.handlingMinutes}`,
      )
    }

    // Hand-check every baseline's volume against a raw count.
    for (const b of baselines) {
      const counted = await prisma.activityEvent.count({
        where: { organizationId, source: b.source, action: b.action, entityType: b.entityType },
      })
      assert.equal(b.volume, counted, `${b.action}: baseline volume ${b.volume} != SQL count ${counted}`)
    }
    console.log('\nvolume hand-check vs SQL count: PASS')

    // The rework case: the deal returned to qualifiedtobuy after leaving it.
    const stage = baselines.find((b) => b.action === 'deal_stage_changed')
    assert.ok(stage, 'expected a deal_stage_changed baseline')
    assert.equal(stage.reworkRate, 1, 'the seeded deal regresses, so rework must be 1')
    assert.equal(stage.medianCycleTimeHours, 24, 'stage changes are 1 day apart')
    console.log('rework + cycle time on seeded regression: PASS')

    // Point-event processes must report null, not 0.
    const email = baselines.find((b) => b.action === 'logged_email')
    assert.ok(email)
    assert.equal(email.medianCycleTimeHours, null, 'point events cannot have cycle time')
    assert.equal(email.reworkRate, null, 'point events cannot have rework — null, not 0')
    console.log('point events report null (not 0) for unmeasurable fields: PASS')

    // Idempotency: a second recompute must not duplicate rows.
    await recomputeOrgBaselines(organizationId, { now: new Date('2026-08-05T00:00:00Z') })
    const after = await prisma.processBaseline.count({ where: { organizationId } })
    assert.equal(after, baselines.length, 'recompute must upsert, not insert duplicates')
    console.log('recompute idempotency: PASS')

    console.log('\nALL VERIFICATION CHECKS PASSED')
  } finally {
    await seeded.cleanup()
    console.log('cleaned up')
  }

}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1) })
