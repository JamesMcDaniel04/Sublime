export type SeriesPoint = { value: number; capturedAt: string }

export function bucketOf(point: SeriesPoint): string {
  return point.capturedAt.slice(0, 10)
}

function latestPerBucket(points: SeriesPoint[]): Map<string, SeriesPoint> {
  const result = new Map<string, SeriesPoint>()
  for (const point of [...points].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))) {
    result.set(bucketOf(point), point)
  }
  return result
}

export function alignSeries(
  a: SeriesPoint[],
  b: SeriesPoint[],
): Array<{ bucketKey: string; a: number; b: number }> {
  const left = latestPerBucket(a)
  const right = latestPerBucket(b)
  return [...left.keys()]
    .filter((bucketKey) => right.has(bucketKey))
    .sort()
    .map((bucketKey) => ({
      bucketKey,
      a: left.get(bucketKey)!.value,
      b: right.get(bucketKey)!.value,
    }))
}

export function ratioSeries(
  numerator: SeriesPoint[],
  denominator: SeriesPoint[],
): SeriesPoint[] {
  const numeratorBuckets = latestPerBucket(numerator)
  return alignSeries(numerator, denominator)
    .filter((row) => row.b !== 0)
    .map((row) => ({
      value: row.a / row.b,
      capturedAt: numeratorBuckets.get(row.bucketKey)!.capturedAt,
    }))
}

export function normalizeSeries(
  points: SeriesPoint[],
): Array<{ capturedAt: string; t: number }> {
  if (points.length === 0) return []
  const values = points.map((point) => point.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  return points.map((point) => ({
    capturedAt: point.capturedAt,
    t: min === max ? 0.5 : (point.value - min) / (max - min),
  }))
}

export function sampleSeries(
  startValue: number,
  targetValue: number,
  startAt: string,
  targetDate: string,
  count = 9,
): SeriesPoint[] {
  if (count <= 0) return []
  const start = new Date(startAt).getTime()
  const end = new Date(targetDate).getTime()
  return Array.from({ length: count }, (_, index) => {
    const t = count === 1 ? 1 : index / (count - 1)
    return {
      value: startValue + (targetValue - startValue) * t,
      capturedAt: new Date(start + (end - start) * t).toISOString(),
    }
  })
}
