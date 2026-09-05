import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_FILE_READ_CHARS, pageContent, resolveFileRef } from '../files'

const files = [
  { id: 'doc_1', filename: 'onboarding-guide.md', title: 'Onboarding guide' },
  { id: 'doc_2', filename: 'pricing.md', title: 'Pricing policy' },
  { id: 'doc_3', filename: 'Q3-plan.docx', title: 'Q3 plan' },
  { id: 'doc_4', filename: 'q3-plan-appendix.md', title: 'Q3 plan appendix' },
]

test('resolveFileRef: id wins, then exact filename or title (case-insensitive)', () => {
  assert.equal(resolveFileRef(files, 'doc_2').file?.id, 'doc_2')
  assert.equal(resolveFileRef(files, 'PRICING.md').file?.id, 'doc_2')
  assert.equal(resolveFileRef(files, 'onboarding guide').file?.id, 'doc_1')
})

test('resolveFileRef: a unique partial match resolves, an ambiguous one lists candidates', () => {
  assert.equal(resolveFileRef(files, 'onboarding').file?.id, 'doc_1')
  const ambiguous = resolveFileRef(files, 'q3')
  assert.equal(ambiguous.file, null)
  assert.deepEqual(ambiguous.candidates.map((c) => c.id).sort(), ['doc_3', 'doc_4'])
  // An exact title beats a longer partial: "Q3 plan" is doc_3 even though doc_4 contains it.
  assert.equal(resolveFileRef(files, 'q3 plan').file?.id, 'doc_3')
})

test('resolveFileRef: nothing resolves for blank or unknown references', () => {
  assert.deepEqual(resolveFileRef(files, '   '), { file: null, candidates: [] })
  assert.deepEqual(resolveFileRef(files, 'security-review'), { file: null, candidates: [] })
})

test('pageContent pages a long body and reports where to continue', () => {
  const body = 'x'.repeat(MAX_FILE_READ_CHARS * 2 + 10)
  const first = pageContent(body)
  assert.equal(first.content.length, MAX_FILE_READ_CHARS)
  assert.equal(first.truncated, true)
  assert.equal(first.nextOffset, MAX_FILE_READ_CHARS)
  const last = pageContent(body, first.nextOffset! + MAX_FILE_READ_CHARS)
  assert.equal(last.content.length, 10)
  assert.equal(last.truncated, false)
  assert.equal(last.nextOffset, null)
  assert.equal(last.totalChars, body.length)
})

test('pageContent clamps hostile offsets and sizes', () => {
  const short = pageContent('hello', -5)
  assert.equal(short.content, 'hello')
  const past = pageContent('hello', 99)
  assert.equal(past.content, '')
  assert.equal(past.truncated, false)
  const huge = pageContent('y'.repeat(100_000), 0, Number.MAX_SAFE_INTEGER)
  assert.equal(huge.content.length, MAX_FILE_READ_CHARS)
  const nan = pageContent('abc', Number.NaN, Number.NaN)
  assert.equal(nan.content, 'abc')
})
