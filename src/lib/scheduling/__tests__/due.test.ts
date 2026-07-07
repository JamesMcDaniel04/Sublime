import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isDue, type AgentSchedule } from '../due.js'

// --- helpers -----------------------------------------------------------------

function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60 * 1000)
}

function hoursAgo(n: number): Date {
  return new Date(Date.now() - n * 60 * 60 * 1000)
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000)
}

/**
 * Returns a `now` Date that represents HH:MM in the given timezone.
 * Builds an absolute instant by parsing what Intl says "today" is in that zone
 * and adding the desired offset.
 */
function nowAtTime(hh: number, mm: number, tz: string): Date {
  // We'll iterate second-by-second... instead, compute it directly.
  // Use a known reference: get today's midnight in the target timezone.
  const ref = new Date()
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(ref)
  const year = Number(parts.find((p) => p.type === 'year')!.value)
  const month = Number(parts.find((p) => p.type === 'month')!.value)
  const day = Number(parts.find((p) => p.type === 'day')!.value)

  // The scheduled instant as a UTC date.
  // Find the UTC offset for the zone at this particular moment by comparing
  // what the zone thinks the date is versus UTC.
  const utcMidnight = Date.UTC(year, month - 1, day)

  // Build an approximation: utcMidnight is midnight *as UTC values* but not
  // necessarily midnight in the target timezone.  We need to find the UTC
  // instant that corresponds to hh:mm in the target zone on *that* local day.
  //
  // Strategy: start from utcMidnight + desired local minutes, then correct
  // for the zone offset by checking what Intl thinks the time is.
  const candidateMs = utcMidnight + (hh * 60 + mm) * 60 * 1000
  const candidate = new Date(candidateMs)
  // Read back what time Intl reports for candidate in tz.
  const timeParts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(candidate)
  const actualHH = Number(timeParts.find((p) => p.type === 'hour')!.value)
  const actualMM = Number(timeParts.find((p) => p.type === 'minute')!.value)
  // Adjust by the difference (handles fixed offsets correctly).
  const diffMs = ((hh - actualHH) * 60 + (mm - actualMM)) * 60 * 1000
  return new Date(candidateMs + diffMs)
}

// --- tests -------------------------------------------------------------------

describe('isDue', () => {
  // 1. manual schedule → always false
  it('returns false for manual schedule', () => {
    const schedule: AgentSchedule = {
      type: 'manual',
      time: '09:00',
      cron: '',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, null, new Date()), false)
    assert.equal(isDue(schedule, minutesAgo(120), new Date()), false)
  })

  // 2. inactive schedule → always false
  it('returns false when isActive is false', () => {
    const schedule: AgentSchedule = {
      type: 'hourly',
      time: '00:00',
      cron: '',
      timezone: 'UTC',
      isActive: false,
    }
    assert.equal(isDue(schedule, null, new Date()), false)
    assert.equal(isDue(schedule, hoursAgo(2), new Date()), false)
  })

  // 3. hourly — never run → due
  it('hourly: returns true when lastExecutedAt is null', () => {
    const schedule: AgentSchedule = {
      type: 'hourly',
      time: '',
      cron: '',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, null, new Date()), true)
  })

  // 4. hourly — ran 59 min ago → NOT due
  it('hourly: returns false when last ran 59 minutes ago', () => {
    const schedule: AgentSchedule = {
      type: 'hourly',
      time: '',
      cron: '',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, minutesAgo(59), new Date()), false)
  })

  // 5. hourly — ran 61 min ago → due
  it('hourly: returns true when last ran 61 minutes ago', () => {
    const schedule: AgentSchedule = {
      type: 'hourly',
      time: '',
      cron: '',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, minutesAgo(61), new Date()), true)
  })

  // 6. daily — before scheduled time today → NOT due
  it('daily: returns false when now is before the scheduled time today', () => {
    // Schedule: runs at 23:59 UTC. now = 08:00 UTC today.
    const now = nowAtTime(8, 0, 'UTC')
    const schedule: AgentSchedule = {
      type: 'daily',
      time: '23:59',
      cron: '',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, null, now), false)
  })

  // 7. daily — after scheduled time today, never ran → due
  it('daily: returns true when now is past the scheduled time and never ran', () => {
    // Schedule: runs at 00:01 UTC. now = 08:00 UTC.
    const now = nowAtTime(8, 0, 'UTC')
    const schedule: AgentSchedule = {
      type: 'daily',
      time: '00:01',
      cron: '',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, null, now), true)
  })

  // 8. daily — past scheduled time but already ran today → NOT due
  it('daily: returns false when already ran today after the scheduled time', () => {
    // Schedule: runs at 09:00 UTC. now = 10:00 UTC. Last ran at 09:30 UTC today.
    const now = nowAtTime(10, 0, 'UTC')
    const scheduledToday = nowAtTime(9, 0, 'UTC')
    // last ran 30 min after the scheduled instant (so after it)
    const lastRan = new Date(scheduledToday.getTime() + 30 * 60 * 1000)
    const schedule: AgentSchedule = {
      type: 'daily',
      time: '09:00',
      cron: '',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, lastRan, now), false)
  })

  // 9. weekly — never ran, after scheduled time → due
  it('weekly: returns true when never ran and now is past the scheduled time', () => {
    const now = nowAtTime(10, 0, 'UTC')
    const schedule: AgentSchedule = {
      type: 'weekly',
      time: '09:00',
      cron: '',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, null, now), true)
  })

  // 10. weekly — ran 6 days ago → NOT due (need 7)
  it('weekly: returns false when last ran 6 days ago', () => {
    const now = nowAtTime(10, 0, 'UTC')
    const schedule: AgentSchedule = {
      type: 'weekly',
      time: '09:00',
      cron: '',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, daysAgo(6), now), false)
  })

  // 11. weekly — ran 8 days ago → due
  it('weekly: returns true when last ran 8 days ago', () => {
    const now = nowAtTime(10, 0, 'UTC')
    const schedule: AgentSchedule = {
      type: 'weekly',
      time: '09:00',
      cron: '',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, daysAgo(8), now), true)
  })

  // 12. cron — minimal matcher: "*/15 * * * *" matches a time that is on the quarter hour
  it('cron: returns true when now matches the cron expression', () => {
    // Use a time that is on the :00 minute boundary — will match "*/15 * * * *"
    const base = nowAtTime(12, 0, 'UTC')
    // set seconds/ms to 0
    const now = new Date(base)
    now.setUTCSeconds(0, 0)
    // verify it's on a 15-min boundary
    const minUTC = now.getUTCMinutes()
    const adjustedMin = Math.floor(minUTC / 15) * 15
    now.setUTCMinutes(adjustedMin, 0, 0)

    const schedule: AgentSchedule = {
      type: 'cron',
      time: '',
      cron: '*/15 * * * *',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, null, now), true)
  })

  // 13. cron — no matching minute in the catch-up window → NOT due
  it('cron: returns false when no cron-matching minute is in the window', () => {
    // "0 3 * * *" = 03:00 every day. now = 10:00, last ran at 04:00 today
    // (after the 03:00 fire) so no matching minute exists in (04:00, 10:00].
    const now = nowAtTime(10, 0, 'UTC')
    const lastExecutedAt = nowAtTime(4, 0, 'UTC')
    const schedule: AgentSchedule = {
      type: 'cron',
      time: '',
      cron: '0 3 * * *',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, lastExecutedAt, now), false)
  })

  // 14. cron catch-up — "0 9 * * *" with lastExecutedAt = yesterday and
  //     now = today 13:00 should return true (the 09:00 minute is in the
  //     (since, now] window even though now itself is not 09:00).
  it('cron: catches up when a matching minute is in the window since last run', () => {
    const now = nowAtTime(13, 0, 'UTC')
    const lastExecutedAt = daysAgo(1)
    const schedule: AgentSchedule = {
      type: 'cron',
      time: '',
      cron: '0 9 * * *',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, lastExecutedAt, now), true)
  })

  // 15. cron catch-up — same "0 9 * * *" cron, but lastExecutedAt = today 10:00
  //     (after the 09:00 fire). No matching minute exists in (10:00, 13:00],
  //     so it should return false.
  it('cron: does not re-fire when last run was after the scheduled minute', () => {
    const now = nowAtTime(13, 0, 'UTC')
    const lastExecutedAt = nowAtTime(10, 0, 'UTC')
    const schedule: AgentSchedule = {
      type: 'cron',
      time: '',
      cron: '0 9 * * *',
      timezone: 'UTC',
      isActive: true,
    }
    assert.equal(isDue(schedule, lastExecutedAt, now), false)
  })
})

describe('isDue — once (one-time)', () => {
  const past = (): AgentSchedule => ({ type: 'once', time: '09:00', cron: '', timezone: 'UTC', runAt: '2020-01-01', isActive: true })

  it('fires when the target instant has passed and it never ran', () => {
    assert.equal(isDue(past(), null, new Date()), true)
  })

  it('does not fire again once it has run', () => {
    assert.equal(isDue(past(), daysAgo(1), new Date()), false)
  })

  it('does not fire before its target instant', () => {
    const schedule: AgentSchedule = { type: 'once', time: '09:00', cron: '', timezone: 'UTC', runAt: '2999-01-01', isActive: true }
    assert.equal(isDue(schedule, null, new Date()), false)
  })

  it('does not fire when inactive', () => {
    assert.equal(isDue({ ...past(), isActive: false }, null, new Date()), false)
  })

  it('does not fire when runAt is missing', () => {
    assert.equal(isDue({ type: 'once', time: '09:00', cron: '', timezone: 'UTC', isActive: true }, null, new Date()), false)
  })

  it('respects the target time on the target day', () => {
    // Target 09:00 UTC today; at 08:00 UTC it is not due, at 10:00 UTC it is.
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    const schedule: AgentSchedule = { type: 'once', time: '09:00', cron: '', timezone: 'UTC', runAt: parts, isActive: true }
    assert.equal(isDue(schedule, null, nowAtTime(8, 0, 'UTC')), false)
    assert.equal(isDue(schedule, null, nowAtTime(10, 0, 'UTC')), true)
  })
})
