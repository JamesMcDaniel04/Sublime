import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { GoalTemplateCard } from '../goal-template-card'
import { goalTemplateByKey } from '@/lib/goals/goal-templates'

afterEach(cleanup)

const template = goalTemplateByKey('sales-org-quarterly-revenue')!

test('renders name, category, scope badge and description', () => {
  render(<GoalTemplateCard template={template} connectedSources={new Set()} connectedIntegrations={new Set()} onOpen={() => {}} />)
  assert.ok(screen.getByText(template.name))
  assert.ok(screen.getByText('Revenue'))
  assert.ok(screen.getByText('Org'))
  assert.ok(screen.getByText(template.description))
})

test('renders a recurrence badge only when the template recurs', () => {
  // The badge renders `↻ {recurrence}` as two text nodes, so match on the
  // element's full textContent rather than an exact string.
  const hasRecurrenceBadge = () =>
    screen.queryAllByText((_, element) => element?.textContent?.trim() === '↻ quarterly').length > 0
  render(<GoalTemplateCard template={template} connectedSources={new Set()} connectedIntegrations={new Set()} onOpen={() => {}} />)
  assert.ok(hasRecurrenceBadge())
  cleanup()
  const noRecurrence = goalTemplateByKey('sales-org-arr-growth')!
  assert.equal(noRecurrence.recurrence, null, 'fixture assumption: this template does not recur')
  render(<GoalTemplateCard template={noRecurrence} connectedSources={new Set()} connectedIntegrations={new Set()} onOpen={() => {}} />)
  assert.equal(hasRecurrenceBadge(), false)
})

test('shows at most three source chips with an overflow count', () => {
  render(<GoalTemplateCard template={template} connectedSources={new Set()} connectedIntegrations={new Set()} onOpen={() => {}} />)
  assert.ok(screen.getByText('Reads from'))
  assert.ok(screen.getByText('Stripe'))
  // sales-org-quarterly-revenue has 5 sources after `manual` is appended.
  assert.ok(screen.getByText(`+${template.sources.length - 3}`))
})

test('is a button that reports the template when activated', () => {
  let opened: string | null = null
  render(
    <GoalTemplateCard
      template={template}
      connectedSources={new Set()} connectedIntegrations={new Set()}
      onOpen={(entry) => { opened = entry.key }}
    />,
  )
  const button = screen.getByRole('button', { name: new RegExp(template.name) })
  assert.equal(button.getAttribute('aria-haspopup'), 'dialog')
  fireEvent.click(button)
  assert.equal(opened, 'sales-org-quarterly-revenue')
})

test('dims sources that are not connected', () => {
  const { container } = render(
    <GoalTemplateCard
      template={template}
      connectedSources={new Set(['stripe'])}
      connectedIntegrations={new Set()}
      onOpen={() => {}}
    />,
  )
  assert.ok(container.querySelector('[data-connected="true"]'), 'connected chip missing')
  assert.ok(container.querySelector('[data-connected="false"]'), 'unconnected chip missing')
})

const actionTemplate = goalTemplateByKey('sales-personal-revive-stalled-deals')!

test('an action card leads with the agents and the artifact, not a data source', () => {
  render(
    <GoalTemplateCard
      template={actionTemplate}
      connectedSources={new Set()}
      connectedIntegrations={new Set()}
      onOpen={() => {}}
    />,
  )
  assert.ok(screen.getByText('Agents do'))
  assert.equal(screen.queryByText('Reads from'), null)
  assert.ok(screen.getByText('Signal-Based Sequence Personalizer'))
  assert.ok(
    screen.queryAllByText((_, element) =>
      (element?.textContent ?? '').includes(actionTemplate.produces!),
    ).length > 0,
    'the card must name what it produces',
  )
})

test('an outcome card still reads from its sources', () => {
  render(
    <GoalTemplateCard
      template={template}
      connectedSources={new Set()}
      connectedIntegrations={new Set()}
      onOpen={() => {}}
    />,
  )
  assert.ok(screen.getByText('Reads from'))
  assert.equal(screen.queryByText('Agents do'), null)
})
