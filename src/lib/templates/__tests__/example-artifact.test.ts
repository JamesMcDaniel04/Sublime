import assert from 'node:assert/strict'
import test from 'node:test'
import { exampleArtifactHtml } from '../example-artifact'

test('shows a populated end product instead of workflow setup instructions', () => {
  const html = exampleArtifactHtml({
    name: 'New Lead to Salesforce Opportunity',
    description: 'Qualify and route a lead.',
    departments: ['sales'],
  })
  assert.match(html, /Acme Corp — Enterprise Expansion/)
  assert.match(html, /\$84,000 ARR/)
  assert.doesNotMatch(html, /Review the evidence gathered/)
  assert.doesNotMatch(html, /Run or publish/)
})
