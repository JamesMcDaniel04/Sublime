import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen } from '@testing-library/react'
import { GoalTemplateDetail } from '../goal-template-detail'
import { goalTemplateByKey } from '@/lib/goals/goal-templates'

afterEach(cleanup)

const template = goalTemplateByKey('sales-org-multithread-open-deals')!

test('the detail dialog lists the agents that work on the goal', () => {
  render(
    <GoalTemplateDetail
      template={template}
      sources={[]}
      sourcesFailed={false}
      onClose={() => {}}
    />,
  )
  assert.ok(screen.getByText('Works on it'))
  // A curated seed and a goal-native seed both appear.
  assert.ok(screen.getByText('Goal Pace Auditor'))
  assert.ok(screen.getByText(/Buying Committee Mapper/i))
})

test('a percent template preview shows a believable percentage', () => {
  // fmtValue renders percent as value * 100, so SAMPLE_TARGETS must be
  // fractions. Whole numbers render "8500%".
  render(
    <GoalTemplateDetail
      template={goalTemplateByKey('csm-org-nrr')!}
      sources={[]}
      sourcesFailed={false}
      onClose={() => {}}
    />,
  )
  // Assert on an element's OWN text, not document.textContent: the history
  // table puts a date cell flush against a value cell, so the concatenated
  // string contains "7/6/2026" + "76%" = "202676%" with nothing wrong.
  assert.ok(screen.getAllByText('85%').length > 0, 'the 85% target should render as 85%')
  assert.equal(screen.queryByText('8500%'), null, 'percent target rendered as whole number')
})

test('a source-dependent agent is shown with its qualifier before the source is chosen', () => {
  render(
    <GoalTemplateDetail
      template={template}
      sources={[]}
      sourcesFailed={false}
      onClose={() => {}}
    />,
  )
  assert.ok(screen.getByText('Goal Metric Collector'))
  assert.ok(screen.getByText(/if you track this goal manually or with AI-read/i))
})
