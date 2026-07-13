import assert from 'node:assert/strict'
import test from 'node:test'
import { withTemplateOutputStandard } from '../output-standard'

test('adds the detailed artifact contract once', () => {
  const once = withTemplateOutputStandard('Analyze the account.')
  const twice = withTemplateOutputStandard(once)
  assert.match(once, /decision-ready artifact/)
  assert.match(once, /should not need to ask you to expand it/)
  assert.match(once, /polished semantic HTML/)
  assert.match(once, /strict JSON schema/)
  assert.equal(twice, once)
})
