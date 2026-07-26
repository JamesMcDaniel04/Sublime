import { prisma } from '@/lib/prisma'

type GroundingGoal = {
  name: string
  riskLevel: string
  direction: string
  unit: string
  startValue: number
  targetValue: number
  startAt: Date
  targetDate: Date
  currentValue: number | null
}

const RISK_ORDER: Record<string, number> = {
  off_track: 0,
  at_risk: 1,
  no_data: 2,
  on_track: 3,
}

function fmt(value: number, unit: string): string {
  if (unit === 'usd') {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value)
  }
  if (unit === 'percent') return `${Math.round(value * 100)}%`
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
}

export function renderGoalGrounding(goals: GroundingGoal[], now = new Date()): string {
  const ranked = [...goals]
    .sort(
      (a, b) =>
        (RISK_ORDER[a.riskLevel] ?? 9) - (RISK_ORDER[b.riskLevel] ?? 9) ||
        a.targetDate.getTime() - b.targetDate.getTime(),
    )
    .slice(0, 3)
  if (ranked.length === 0) return ''

  const lines = ranked.map((goal) => {
    const elapsed = now.getTime() - goal.startAt.getTime()
    const duration = Math.max(1, goal.targetDate.getTime() - goal.startAt.getTime())
    const expectedProgress = Math.min(1, Math.max(0, elapsed / duration))
    const expected =
      goal.startValue + expectedProgress * (goal.targetValue - goal.startValue)
    const gap =
      goal.currentValue === null
        ? null
        : goal.direction === 'decrease'
          ? goal.currentValue - expected
          : expected - goal.currentValue
    const risk = goal.riskLevel.replace('_', ' ')
    return `- ${goal.name}: ${fmt(goal.currentValue ?? goal.startValue, goal.unit)} now → ${fmt(goal.targetValue, goal.unit)} by ${goal.targetDate.toISOString().slice(0, 10)}; ${risk}${gap === null ? '' : `, ${fmt(Math.abs(gap), goal.unit)} ${gap > 0 ? 'behind' : 'ahead of'} pace`}.`
  })
  // Cap at a LINE boundary — a mid-word truncation reads as prompt corruption.
  const all = ['Active goals (the user is working toward these):', ...lines]
  let block = ''
  for (const line of all) {
    const next = block ? `${block}\n${line}` : line
    if (next.length > 600) break
    block = next
  }
  return block
}

/** Best-effort bounded grounding. A failed goal read must never break a run. */
export async function goalGroundingBlock(
  organizationId: string,
  userId?: string,
): Promise<string> {
  try {
    const goals = await prisma.goal.findMany({
      where: {
        organizationId,
        status: 'active',
        ...(userId
          ? { OR: [{ ownerUserId: null }, { ownerUserId: userId }] }
          : { ownerUserId: null }),
      },
      orderBy: { targetDate: 'asc' },
      include: {
        metrics: {
          where: { role: 'primary' },
          take: 1,
          select: {
            datapoints: {
              orderBy: { capturedAt: 'desc' },
              take: 1,
              select: { value: true },
            },
          },
        },
      },
      take: 50,
    })
    return renderGoalGrounding(
      goals.map((goal) => ({
        ...goal,
        currentValue: goal.metrics[0]?.datapoints[0]?.value ?? null,
      })),
    )
  } catch {
    return ''
  }
}
