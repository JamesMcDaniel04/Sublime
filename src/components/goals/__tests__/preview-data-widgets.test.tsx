/**
 * Every single-metric widget must survive rendering against preview data.
 * The template modal renders real GoalDashboard widgets against a synthetic
 * goal, so a widget that assumes a persisted goal would blow up the modal.
 */
import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup } from '@testing-library/react'
import { GoalDashboard } from '../widgets/goal-dashboard'
import { buildPreviewDashboardData } from '@/lib/goals/preview-data'
import type { DashboardLayout, WidgetType } from '@/lib/goals/dashboard'

afterEach(cleanup)

const SINGLE_METRIC_WIDGETS: WidgetType[] = [
  'kpi', 'trend', 'progress', 'impact', 'benchmark',
  'periods', 'contributions', 'history', 'rollups',
]

const { data } = buildPreviewDashboardData({
  name: 'Preview goal',
  kind: 'arr',
  direction: 'increase',
  unit: 'usd',
  startValue: 1000,
  targetValue: 5000,
  targetDate: null,
  recurrence: null,
  personal: false,
  metrics: [{ label: 'Revenue', role: 'primary', unit: 'usd', source: 'stripe', metricKey: 'net_revenue' }],
  seed: 'widget-render',
})

for (const type of SINGLE_METRIC_WIDGETS) {
  test(`${type} renders against preview data`, () => {
    const layout: DashboardLayout = {
      version: 1,
      widgets: [{ id: `preview-${type}`, type, config: {} }],
    }
    assert.doesNotThrow(() => {
      render(<GoalDashboard layout={layout} data={data} />)
    })
  })
}
