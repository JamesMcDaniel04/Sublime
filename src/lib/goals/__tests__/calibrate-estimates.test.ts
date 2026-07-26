import assert from 'node:assert/strict'
import test from 'node:test'
import {
  medianMinutes,
  selectEstimateCalibrations,
  shouldRunEstimateCalibration,
} from '@/lib/goals/calibrate-estimates'

test('median handles odd values and even ties deterministically', () => {
  assert.equal(medianMinutes([45, 15, 30]), 30)
  assert.equal(medianMinutes([10, 20, 30, 40]), 25)
  assert.equal(medianMinutes([]), null)
})

test('calibration applies the distinct-org floor and ignores shipped defaults', () => {
  const defaults = new Map([['weekly-brief', 30]])
  const below = selectEstimateCalibrations(
    [
      { seedKey: 'weekly-brief', organizationId: 'a', estimatedMinutesSavedPerRun: 40 },
      { seedKey: 'weekly-brief', organizationId: 'b', estimatedMinutesSavedPerRun: 50 },
      { seedKey: 'weekly-brief', organizationId: 'c', estimatedMinutesSavedPerRun: 30 },
    ],
    defaults,
  )
  assert.deepEqual(below, [])

  const qualified = selectEstimateCalibrations(
    [
      { seedKey: 'weekly-brief', organizationId: 'a', estimatedMinutesSavedPerRun: 40 },
      { seedKey: 'weekly-brief', organizationId: 'b', estimatedMinutesSavedPerRun: 50 },
      { seedKey: 'weekly-brief', organizationId: 'c', estimatedMinutesSavedPerRun: 60 },
      { seedKey: 'weekly-brief', organizationId: 'd', estimatedMinutesSavedPerRun: 30 },
    ],
    defaults,
  )
  assert.deepEqual(qualified, [
    { seedKey: 'weekly-brief', medianMinutes: 50, orgCount: 3 },
  ])
})

test('calibration runs only in the Monday 04:00 UTC cron window', () => {
  assert.equal(shouldRunEstimateCalibration(new Date('2026-07-27T04:07:00Z')), true)
  assert.equal(shouldRunEstimateCalibration(new Date('2026-07-27T04:16:00Z')), false)
  assert.equal(shouldRunEstimateCalibration(new Date('2026-07-28T04:07:00Z')), false)
})
