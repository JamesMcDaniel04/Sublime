import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen } from '@testing-library/react'
import { GoalTemplateDetail } from '../goal-template-detail'
import { goalTemplateByKey } from '@/lib/goals/goal-templates'
import type { MetricSourceOption } from '@/lib/metrics/source-options'

afterEach(cleanup)

const orgTemplate = goalTemplateByKey('sales-org-quarterly-revenue')!
const personalTemplate = goalTemplateByKey('sales-personal-quota')!

const sources: MetricSourceOption[] = [
  { source: 'stripe', group: 'source_of_truth', metrics: [], connections: [{ ref: 'c1', label: 'Acme' }] },
  { source: 'hubspot', group: 'source_of_truth', metrics: [], connections: [] },
  { source: 'manual', group: 'start_now', metrics: [], connections: [] },
]

test('renders nothing when no template is selected', () => {
  const { container } = render(
    <GoalTemplateDetail template={null} sources={[]} sourcesFailed={false} onClose={() => {}} />,
  )
  assert.equal(container.textContent, '')
})

test('shows the name, tracks copy and direction', () => {
  render(<GoalTemplateDetail template={orgTemplate} sources={sources} sourcesFailed={false} onClose={() => {}} />)
  // The name appears twice by design — the dialog title and the preview
  // dashboard's metric label — so assert presence rather than uniqueness.
  assert.ok(screen.getAllByText(orgTemplate.name).length > 0)
  assert.ok(screen.getByText(orgTemplate.tracks))
  // "This number should go **up** over time." is split across a <strong>.
  const direction = screen.getAllByText(
    (_, element) => element?.textContent?.trim() === 'This number should go up over time.',
  )
  assert.ok(direction.length > 0, 'direction copy missing')
})

test('states org scope plainly', () => {
  render(<GoalTemplateDetail template={orgTemplate} sources={sources} sourcesFailed={false} onClose={() => {}} />)
  assert.ok(screen.getByText(/visible to everyone in your workspace/i))
})

test('states personal scope plainly', () => {
  render(<GoalTemplateDetail template={personalTemplate} sources={sources} sourcesFailed={false} onClose={() => {}} />)
  assert.ok(screen.getByText(/visible only to you/i))
})

test('marks the first connected source as recommended and offers a connect link for the rest', () => {
  render(<GoalTemplateDetail template={orgTemplate} sources={sources} sourcesFailed={false} onClose={() => {}} />)
  assert.ok(screen.getByText('Recommended'))
  assert.ok(screen.getAllByText('Connect').length > 0)
})

test('when the source probe failed, no source is marked recommended', () => {
  render(<GoalTemplateDetail template={orgTemplate} sources={[]} sourcesFailed onClose={() => {}} />)
  assert.equal(screen.queryByText('Recommended'), null)
  assert.equal(screen.queryByText('Connect'), null)
})

test('links Use template at the prefill URL', () => {
  render(
    <GoalTemplateDetail template={orgTemplate} sources={sources} sourcesFailed={false} onClose={() => {}} />,
  )
  const link = [...document.body.querySelectorAll('a')].find(
    (anchor) => anchor.textContent?.includes('Use template'),
  )
  assert.ok(link)
  // Scoped: every app surface now lives under /g/[scope], and this component
  // renders outside a route with a scope param, so it resolves to the
  // all-goals lens. The template KEY in the query is the part that must never
  // change — bookmarked links depend on it.
  assert.equal(link?.getAttribute('href'), '/g/all/goals/new?template=sales-org-quarterly-revenue')
})

test('labels the preview as sample data', () => {
  render(<GoalTemplateDetail template={orgTemplate} sources={sources} sourcesFailed={false} onClose={() => {}} />)
  assert.ok(screen.getByText(/sample data/i))
})
