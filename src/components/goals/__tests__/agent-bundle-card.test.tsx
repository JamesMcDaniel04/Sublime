import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen } from '@testing-library/react'
import { AgentBundleCard } from '../agent-bundle-card'

afterEach(cleanup)

const base = {
  goalId: 'goal-1',
  templateKey: 'sales-org-pipeline-coverage',
  kind: 'custom_kpi',
  source: 'hubspot',
  recurrence: null,
  onChanged: async () => {},
}

test('an agent whose tools are all connected offers a Deploy button', () => {
  render(
    <AgentBundleCard
      {...base}
      deployedSeedKeys={[]}
      connectedIntegrations={['slack', 'salesforce', 'granola', 'hubspot']}
    />,
  )
  assert.ok(screen.getAllByRole('button', { name: /deploy/i }).length > 0)
})

test('a blocked agent names what is missing instead of offering Deploy', () => {
  render(<AgentBundleCard {...base} deployedSeedKeys={[]} connectedIntegrations={[]} />)
  assert.ok(screen.getAllByText(/needs/i).length > 0)
})

test('an already-deployed agent is shown as deployed, not re-offered', () => {
  render(
    <AgentBundleCard
      {...base}
      deployedSeedKeys={['sales-pipeline-hygiene-nudger']}
      connectedIntegrations={['slack', 'salesforce', 'granola']}
    />,
  )
  assert.ok(screen.getByText(/deployed/i))
})

test('the card renders nothing when everything is already deployed', () => {
  const { container } = render(
    <AgentBundleCard
      goalId="goal-1"
      templateKey={null}
      kind="not_a_real_kind"
      source="stripe"
      recurrence={null}
      deployedSeedKeys={['goal-pace-auditor']}
      connectedIntegrations={[]}
      onChanged={async () => {}}
      hideWhenAllDeployed
    />,
  )
  assert.equal(container.textContent?.includes('Put agents to work'), false)
})
