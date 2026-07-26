import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'
import { getSeedByKey } from '@/lib/templates/catalogue'

export const MIN_CALIBRATION_ORGS = 3

export type EstimateEdit = {
  seedKey: string
  organizationId: string
  estimatedMinutesSavedPerRun: number
}

export type EstimateCalibration = {
  seedKey: string
  medianMinutes: number
  orgCount: number
}

export function medianMinutes(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

export function effectiveTemplateEstimate(
  shippedDefault: number | null | undefined,
  calibration: { medianMinutes: number } | null,
): number {
  return calibration?.medianMinutes ?? shippedDefault ?? 30
}

export function selectEstimateCalibrations(
  links: EstimateEdit[],
  shippedDefaults: ReadonlyMap<string, number>,
  minOrgs = MIN_CALIBRATION_ORGS,
): EstimateCalibration[] {
  const grouped = new Map<string, EstimateEdit[]>()
  for (const link of links) {
    const shippedDefault = shippedDefaults.get(link.seedKey)
    if (shippedDefault === undefined || link.estimatedMinutesSavedPerRun === shippedDefault) continue
    const group = grouped.get(link.seedKey) ?? []
    group.push(link)
    grouped.set(link.seedKey, group)
  }

  return [...grouped.entries()].flatMap(([seedKey, group]) => {
    const orgCount = new Set(group.map((link) => link.organizationId)).size
    const median = medianMinutes(group.map((link) => link.estimatedMinutesSavedPerRun))
    return orgCount >= minOrgs && median !== null
      ? [{ seedKey, medianMinutes: median, orgCount }]
      : []
  })
}

export function shouldRunEstimateCalibration(now: Date): boolean {
  return now.getUTCDay() === 1 && now.getUTCHours() === 4 && now.getUTCMinutes() < 15
}

/**
 * Global k-anonymous aggregation. Only seed key, integer estimate and distinct
 * org count cross tenant boundaries; existing contribution rows never change.
 */
export async function calibrateTemplateEstimates(
  db = systemPrisma,
): Promise<{ calibrations: number } | { skipped: string }> {
  try {
    const links = await db.goalContribution.findMany({
      where: { seedKey: { not: null } },
      select: {
        seedKey: true,
        organizationId: true,
        estimatedMinutesSavedPerRun: true,
      },
      take: 10_000,
    })
    const seedKeys = [...new Set(links.flatMap((link) => (link.seedKey ? [link.seedKey] : [])))]
    const shippedDefaults = new Map(
      seedKeys.flatMap((seedKey) => {
        const seed = getSeedByKey(seedKey)
        return seed ? [[seedKey, seed.estimatedMinutesSaved ?? 30] as const] : []
      }),
    )
    const rows = selectEstimateCalibrations(
      links.flatMap((link) =>
        link.seedKey
          ? [{
              seedKey: link.seedKey,
              organizationId: link.organizationId,
              estimatedMinutesSavedPerRun: link.estimatedMinutesSavedPerRun,
            }]
          : [],
      ),
      shippedDefaults,
    )
    for (const row of rows) {
      await db.templateEstimateCalibration.upsert({
        where: { seedKey: row.seedKey },
        create: row,
        update: { medianMinutes: row.medianMinutes, orgCount: row.orgCount },
      })
    }
    return { calibrations: rows.length }
  } catch (error) {
    apiLogger.warn('calibrateTemplateEstimates failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    captureError(error, { scope: 'goals.calibrate-estimates' })
    return { skipped: 'error' }
  }
}
