import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_IMPORT_ROWS, parseDatapointCsv } from '../csv-import'

test('parses header/no-header, currency values, reports bad lines by number', () => {
  const { rows, skipped } = parseDatapointCsv(
    [
      'date,value',
      '2026-01-05,$1,000', // three cells after naive split — but "$1,000" splits! expect skip
      '2026-01-06,1200',
      'not-a-date,900',
      '2026-01-07,soon',
      '',
      '2026-01-06,999', // duplicate day
    ].join('\n'),
  )
  assert.deepEqual(
    rows.map((row) => row.bucketKey),
    ['2026-01-06'],
  )
  assert.equal(rows[0].value, 1200)
  const reasons = Object.fromEntries(skipped.map((skip) => [skip.line, skip.reason]))
  assert.match(reasons[2], /two columns/) // "$1,000" contains a comma — explicit, not silent
  assert.match(reasons[4], /not a date/)
  assert.match(reasons[5], /not a number/)
  assert.match(reasons[7], /duplicate day/)
})

test('headerless numeric first line imports; future dates rejected; row cap enforced', () => {
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const base = parseDatapointCsv(`2026-01-01,50\n${future},60`)
  assert.equal(base.rows.length, 1)
  assert.match(base.skipped[0].reason, /future-dated/)

  const big = Array.from({ length: MAX_IMPORT_ROWS + 5 }, (_, index) => {
    const day = new Date(Date.UTC(2020, 0, 1) + index * 24 * 60 * 60 * 1000)
    return `${day.toISOString().slice(0, 10)},${index}`
  }).join('\n')
  const capped = parseDatapointCsv(big)
  assert.equal(capped.rows.length, MAX_IMPORT_ROWS)
  assert.equal(capped.skipped.length, 5)
  assert.match(capped.skipped[0].reason, /row limit/)
})
