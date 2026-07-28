/**
 * Characterization test for TemplateCatalogueCard, written before it was
 * refactored onto TemplateCardShell. Its job is to fail loudly if the shared
 * shell changes what the agent and flow catalogues render.
 */
import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen } from '@testing-library/react'
import { TemplateCatalogueCard } from '../template-catalogue-card'

afterEach(cleanup)

const props = {
  href: '/templates/weekly-digest',
  name: 'Weekly revenue digest',
  description: 'Summarize closed-won and pipeline movement every Monday.',
  category: 'Revenue',
  integrations: ['Slack', 'HubSpot'] as const,
}

test('renders title, category, description, integrations and CTA', () => {
  render(<TemplateCatalogueCard {...props} />)
  assert.ok(screen.getByText('Weekly revenue digest'))
  assert.ok(screen.getByText('Revenue'))
  assert.ok(screen.getByText(props.description))
  assert.ok(screen.getByText('Requires'))
  assert.ok(screen.getByText('Slack'))
  assert.ok(screen.getByText('HubSpot'))
  assert.ok(screen.getByText('Use template'))
})

test('links to the template href', () => {
  const { container } = render(<TemplateCatalogueCard {...props} />)
  const link = container.querySelector('a')
  assert.ok(link)
  assert.equal(link?.getAttribute('href'), '/templates/weekly-digest')
})

test('renders a gradient accent bar and an icon tile', () => {
  const { container } = render(<TemplateCatalogueCard {...props} />)
  assert.ok(container.querySelector('.bg-gradient-to-r'), 'accent bar missing')
  assert.ok(container.querySelector('svg'), 'icon tile missing')
})

test('flow variant adds a Flow badge', () => {
  render(<TemplateCatalogueCard {...props} kind="flow" />)
  assert.ok(screen.getByText('Flow'))
})

test('advancesGoal renders the goal badge', () => {
  render(<TemplateCatalogueCard {...props} advancesGoal="Grow ARR" />)
  assert.ok(screen.getByText('Advances: Grow ARR'))
})

test('a custom actionLabel replaces the default CTA text', () => {
  render(<TemplateCatalogueCard {...props} actionLabel="Deploy agent" />)
  assert.ok(screen.getByText('Deploy agent'))
  assert.equal(screen.queryByText('Use template'), null)
})

test('the integrations block is omitted when there are none', () => {
  render(<TemplateCatalogueCard {...props} integrations={[]} />)
  assert.equal(screen.queryByText('Requires'), null)
})

test('falls back to a Works with row when nothing is required', () => {
  render(
    <TemplateCatalogueCard
      {...props}
      integrations={[]}
      recommendedIntegrations={['Slack', 'Gmail']}
    />,
  )
  assert.ok(screen.getByText('Works with'))
  assert.ok(screen.getByText('Slack'))
  assert.ok(screen.getByText('Gmail'))
  assert.equal(screen.queryByText('Requires'), null)
})

test('required integrations win — recommended ones stay hidden', () => {
  render(
    <TemplateCatalogueCard
      {...props}
      integrations={['HubSpot']}
      recommendedIntegrations={['Slack']}
    />,
  )
  assert.ok(screen.getByText('Requires'))
  assert.equal(screen.queryByText('Works with'), null)
  assert.equal(screen.queryByText('Slack'), null)
})
