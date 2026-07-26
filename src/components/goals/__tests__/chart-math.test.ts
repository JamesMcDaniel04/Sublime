import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmtValue, linePath, niceTicks, scaleLinear } from '../chart-math'

test('scaleLinear maps domains and handles degenerate input', () => {
  assert.equal(scaleLinear([0, 100], [0, 200])(50), 100)
  assert.equal(scaleLinear([5, 5], [0, 200])(5), 100)
})

test('linePath emits rounded SVG commands', () => {
  assert.equal(linePath([]), '')
  assert.equal(linePath([{ x: 1.234, y: 4.567 }]), 'M 1.23 4.57')
  assert.equal(
    linePath([
      { x: 0, y: 1 },
      { x: 2, y: 3 },
    ]),
    'M 0 1 L 2 3',
  )
})

test('niceTicks returns round values spanning the domain', () => {
  const ticks = niceTicks(0, 97)
  assert.ok(ticks[0] <= 0)
  assert.ok(ticks.at(-1)! >= 97)
  assert.ok(ticks.every((tick) => Number.isFinite(tick)))
})

test('fmtValue renders compact units', () => {
  assert.equal(fmtValue(41203.5, 'usd'), '$41.2k')
  assert.equal(fmtValue(0.12, 'percent'), '12%')
  assert.equal(fmtValue(1_200_000, 'usd'), '$1.2M')
})
