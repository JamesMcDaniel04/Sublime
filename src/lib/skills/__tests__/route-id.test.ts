import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeSkillRouteId } from '../route-id'

test('decodes built-in skill ids from normal and encoded route segments', () => {
  assert.equal(decodeSkillRouteId('skill:executive-brief'), 'skill:executive-brief')
  assert.equal(decodeSkillRouteId('skill%3Aexecutive-brief'), 'skill:executive-brief')
  assert.equal(decodeSkillRouteId('skill%253Aexecutive-brief'), 'skill:executive-brief')
})

test('leaves malformed percent encoding intact', () => {
  assert.equal(decodeSkillRouteId('skill%broken'), 'skill%broken')
})
