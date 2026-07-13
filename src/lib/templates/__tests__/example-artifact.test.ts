import assert from 'node:assert/strict'
import test from 'node:test'
import { artifactOutputContract, exampleArtifactHtml } from '../example-artifact'

test('shows a populated end product instead of workflow setup instructions', () => {
  const html = exampleArtifactHtml({
    name: 'New Lead to Salesforce Opportunity',
    description: 'Qualify and route a lead.',
    departments: ['sales'],
  })
  assert.match(html, /Acme Corp is a strong enterprise-fit opportunity/)
  assert.match(html, /\$84K/)
  assert.match(html, /Priority findings/)
  assert.match(html, /Action plan/)
  assert.match(html, /Evidence trail/)
  assert.match(html, /class="metric-grid"/)
  assert.doesNotMatch(html, /Review the evidence gathered/)
  assert.doesNotMatch(html, /Run or publish/)
})

test('shares the rendered artifact structure with executable agent instructions', () => {
  const contract = artifactOutputContract({
    name: 'New Lead to Salesforce Opportunity',
    description: 'Qualify and route a lead.',
    departments: ['sales'],
  })
  assert.match(contract, /match the Output Example/)
  assert.match(contract, /<main class="artifact theme-sales">/)
  assert.match(contract, /class="metric-grid"/)
  assert.match(contract, /Priority findings/)
  assert.match(contract, /Action plan/)
  assert.match(contract, /Evidence trail/)
  assert.match(contract, /Do not copy catalogue sample/)
  assert.match(contract, /Slack mrkdwn/)
})
