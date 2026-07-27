import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen } from '@testing-library/react'
import { GoalTemplateDetail } from '../goal-template-detail'
import { goalTemplateByKey } from '@/lib/goals/goal-templates'

afterEach(cleanup)

const template = goalTemplateByKey('sales-org-pipeline-coverage')!

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
  assert.ok(screen.getByText(/Pipeline Hygiene/i))
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
