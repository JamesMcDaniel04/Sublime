import assert from 'node:assert/strict'
import test from 'node:test'
import { alignSeries, normalizeSeries, ratioSeries, sampleSeries } from '../series-math'

const point = (day: string, value: number) => ({
  value,
  capturedAt: `${day}T12:00:00.000Z`,
})

test('alignSeries inner-joins by UTC day and keeps the latest reading', () => {
  assert.deepEqual(
    alignSeries(
      [
        point('2026-07-01', 10),
        { value: 12, capturedAt: '2026-07-01T18:00:00.000Z' },
        point('2026-07-02', 20),
      ],
      [point('2026-07-01', 100), point('2026-07-03', 300)],
    ),
    [{ bucketKey: '2026-07-01', a: 12, b: 100 }],
  )
})

test('ratio skips zero denominators and normalize handles ranges and flats', () => {
  assert.deepEqual(
    ratioSeries(
      [point('2026-07-01', 5), point('2026-07-02', 8)],
      [point('2026-07-01', 50), point('2026-07-02', 0)],
    ),
    [{ value: 0.1, capturedAt: '2026-07-01T12:00:00.000Z' }],
  )
  assert.deepEqual(
    normalizeSeries([
      point('2026-07-01', 10),
      point('2026-07-02', 20),
      point('2026-07-03', 15),
    ]).map((item) => item.t),
    [0, 1, 0.5],
  )
  assert.deepEqual(
    normalizeSeries([point('2026-07-01', 7), point('2026-07-02', 7)]).map(
      (item) => item.t,
    ),
    [0.5, 0.5],
  )
})

test('sampleSeries is a deterministic ramp', () => {
  const sample = sampleSeries(
    100,
    200,
    '2026-07-01T00:00:00.000Z',
    '2026-07-09T00:00:00.000Z',
  )
  assert.equal(sample.length, 9)
  assert.equal(sample[0].value, 100)
  assert.equal(sample.at(-1)?.value, 200)
})
