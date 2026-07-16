import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractMentions, splitMentionSegments } from '../comment-mentions'

const MEMBERS = [
  { id: 'u1', name: 'James' },
  { id: 'u2', name: 'James Smith' },
  { id: 'u3', name: 'Priya' },
]

test('extractMentions matches case-insensitively at word boundaries', () => {
  assert.deepEqual(extractMentions('hey @priya can you look?', MEMBERS), ['u3'])
  assert.deepEqual(extractMentions('hey @Priyanka', MEMBERS), []) // no boundary after "Priya"
  assert.deepEqual(extractMentions('no mentions here', MEMBERS), [])
})

test('the longest member name wins', () => {
  assert.deepEqual(extractMentions('cc @James Smith please', MEMBERS), ['u2'])
  assert.deepEqual(extractMentions('cc @James please', MEMBERS), ['u1'])
})

test('mentions are deduped but order of first appearance is kept', () => {
  assert.deepEqual(extractMentions('@Priya then @James then @Priya again', MEMBERS), ['u3', 'u1'])
})

test('splitMentionSegments preserves the original text exactly', () => {
  const body = 'Ask @James Smith about this, and @priya too.'
  const segments = splitMentionSegments(body, MEMBERS)
  assert.equal(segments.map((segment) => segment.text).join(''), body)
  assert.deepEqual(
    segments.filter((segment) => segment.mention).map((segment) => segment.text),
    ['@James Smith', '@priya'],
  )
})

test('an unmatched @ stays plain text', () => {
  const segments = splitMentionSegments('email me @ home', MEMBERS)
  assert.deepEqual(segments, [{ text: 'email me @ home', mention: false }])
})

test('empty member list never produces mentions', () => {
  assert.deepEqual(extractMentions('@James', []), [])
  assert.deepEqual(splitMentionSegments('@James', []), [{ text: '@James', mention: false }])
})
