export function scaleLinear(
  domain: [number, number],
  range: [number, number],
): (value: number) => number {
  const [d0, d1] = domain
  const [r0, r1] = range
  if (d0 === d1) return () => (r0 + r1) / 2
  const factor = (r1 - r0) / (d1 - d0)
  return (value) => r0 + (value - d0) * factor
}

const rounded = (value: number) => Number(value.toFixed(2))

export function linePath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return ''
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${rounded(point.x)} ${rounded(point.y)}`)
    .join(' ')
}

function niceStep(span: number, count: number): number {
  const rough = span / Math.max(1, count)
  const power = 10 ** Math.floor(Math.log10(rough))
  const fraction = rough / power
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10
  return nice * power
}

export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return []
  if (min === max) {
    const padding = Math.abs(min || 1) * 0.1
    min -= padding
    max += padding
  }
  if (min > max) [min, max] = [max, min]
  const step = niceStep(max - min, count)
  const start = Math.floor(min / step) * step
  const end = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let value = start; value <= end + step / 2; value += step) {
    ticks.push(rounded(value))
  }
  return ticks
}

function compact(value: number): string {
  const absolute = Math.abs(value)
  if (absolute >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`
  if (absolute >= 1_000) return `${Number((value / 1_000).toFixed(1))}k`
  return Number(value.toFixed(1)).toLocaleString('en-US')
}

export function fmtValue(value: number, unit: string): string {
  if (unit === 'percent') return `${Number((value * 100).toFixed(1))}%`
  if (unit === 'usd') return `$${compact(value)}`
  return compact(value)
}
