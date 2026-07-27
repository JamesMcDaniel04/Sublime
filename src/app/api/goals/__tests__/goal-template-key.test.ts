import { test } from 'node:test'
import assert from 'node:assert/strict'
import { goalTemplateByKey, GOAL_TEMPLATES } from '@/lib/goals/goal-templates'

// The wizard sends whatever ?template= contained. A goal must never persist a
// templateKey that does not resolve, or the bundle lookup silently degrades to
// the fallback path with no signal that curation was expected.
test('every goal template key is resolvable, so a persisted templateKey is meaningful', () => {
  assert.ok(GOAL_TEMPLATES.length >= 45)
  for (const template of GOAL_TEMPLATES) {
    assert.equal(goalTemplateByKey(template.key)?.key, template.key)
  }
  assert.equal(goalTemplateByKey('not-a-real-template'), null)
})
