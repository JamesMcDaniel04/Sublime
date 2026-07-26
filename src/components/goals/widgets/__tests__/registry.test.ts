import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WIDGET_TYPES } from '@/lib/goals/dashboard'
import { WIDGET_COMPONENTS } from '../goal-dashboard'

test('widget registry covers the complete closed vocabulary', () => {
  assert.deepEqual(
    Object.keys(WIDGET_COMPONENTS).sort(),
    [...WIDGET_TYPES].sort(),
  )
})
