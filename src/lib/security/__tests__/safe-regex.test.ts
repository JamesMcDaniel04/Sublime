import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertSafeRegexSource,
  safeRegexTest,
  UnsafeRegexError,
  MAX_PATTERN_LENGTH,
} from '../safe-regex'

function rejects(source: string): void {
  assert.throws(() => assertSafeRegexSource(source), UnsafeRegexError, `expected ${source} to be rejected`)
}
function accepts(source: string): void {
  assert.doesNotThrow(() => assertSafeRegexSource(source), `expected ${source} to be accepted`)
}

test('rejects nested unbounded quantifiers (star height >= 2)', () => {
  rejects('(a+)+')
  rejects('(a*)*')
  rejects('(a+)*$')
  rejects('(\\d*\\w*)*')
  rejects('([a-z]+)+@')
  rejects('(a{2,})+')
  rejects('((b+))+')
})

test('rejects quantified alternation with overlapping branch prefixes', () => {
  rejects('(a|ab)*')
  rejects('(x|x)+')
  rejects('(foo|f)*')
  // Unanalyzable branch openings are treated as ambiguous — fail safe.
  rejects('(\\d|a)*')
  rejects('((a)|b)*')
})

test('accepts quantified alternation with disjoint first characters', () => {
  accepts('(foo|bar)+')
  accepts('(cat|dog|emu)*')
  accepts('(a|b|c)+')
})

test('accepts ordinary patterns used in real conditions', () => {
  accepts('^INV-\\d+$')
  accepts('error|warning')
  accepts('[A-Z]{2,4}-\\d{3,6}')
  accepts('.*@example\\.com$')
  accepts('^\\s*$')
  accepts('(?:https?://)\\S+')
  // Bounded quantifiers cannot blow up, even nested.
  accepts('(a+){1,3}')
  accepts('(ab){2,5}')
})

test('escaped metacharacters do not open groups or quantify', () => {
  accepts('\\(a+\\)+')
  accepts('a\\+\\+')
  accepts('\\[a+\\]+')
})

test('character classes are not parsed as groups', () => {
  accepts('[()|]+')
  accepts('[+*]+')
})

test('rejects patterns beyond the length cap', () => {
  rejects('a'.repeat(MAX_PATTERN_LENGTH + 1))
  accepts('a'.repeat(MAX_PATTERN_LENGTH))
})

test('safeRegexTest matches safe patterns and refuses unsafe ones', () => {
  assert.equal(safeRegexTest('^INV-\\d+$', 'INV-402'), true)
  assert.equal(safeRegexTest('^INV-\\d+$', 'PO-402'), false)
  // Unsafe pattern → false, never an exception and never executed.
  assert.equal(safeRegexTest('(a+)+$', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaX'), false)
  // Invalid pattern → false rather than a thrown SyntaxError.
  assert.equal(safeRegexTest('(unclosed', 'x'), false)
})

test('safeRegexTest returns promptly on input that would hang a naive engine', () => {
  // The canonical evil pair: naive `new RegExp(p).test(s)` runs for minutes.
  const evil = '(a+)+$'
  const subject = `${'a'.repeat(40)}X`
  const started = process.hrtime.bigint()
  assert.equal(safeRegexTest(evil, subject), false)
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  assert.ok(elapsedMs < 100, `expected refusal to be immediate, took ${elapsedMs}ms`)
})

test('subjects longer than the cap are truncated rather than refused', () => {
  const long = `${'b'.repeat(200_000)}needle`
  // The needle sits past the cap, so it is not found — but the call returns.
  assert.equal(safeRegexTest('needle', long), false)
  assert.equal(safeRegexTest('^b+', long), true)
})
