import '@/test-support/jsdom-env'
import { test, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { GoalTemplateGallery } from '../goal-template-gallery'
import { VISIBLE_GOAL_TEMPLATES, goalTemplateByKey } from '@/lib/goals/goal-templates'

const PAGE_SIZE = 9

/** Exact match, not /next/i: several template cards are themselves buttons
 *  whose description contains the word "next" ("a next-best play per
 *  account"), so a fuzzy query matches the cards as well as the pager. */
const nextPageButton = () => screen.queryByRole('button', { name: 'Next' })

beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const body = url.includes('/api/integrations/available')
      ? { success: true, tools: [] }
      : { sources: [] }
    return { ok: true, status: 200, json: async () => body } as Response
  }) as typeof fetch
})
afterEach(cleanup)

test('shows exactly one page of templates at a time', () => {
  render(<GoalTemplateGallery />)
  assert.equal(screen.getAllByText('View goal').length, PAGE_SIZE)
})

test('paging forward shows the next slice', () => {
  render(<GoalTemplateGallery />)
  const firstName = VISIBLE_GOAL_TEMPLATES[0].name
  assert.ok(screen.getByText(firstName))
  fireEvent.click(nextPageButton()!)
  assert.equal(screen.queryByText(firstName), null)
  assert.ok(screen.getByText(VISIBLE_GOAL_TEMPLATES[PAGE_SIZE].name))
})

test('picking a department resets to page 1 and hides the pager', () => {
  render(<GoalTemplateGallery />)
  fireEvent.click(nextPageButton()!)
  fireEvent.click(screen.getByRole('tab', { name: 'Sales' }))
  // Nine VISIBLE per department means one page — the pager renders nothing.
  assert.equal(nextPageButton(), null)
  assert.equal(screen.getAllByText('View goal').length, 9)
})

test('a retired template resolves by key but never reaches the grid', () => {
  assert.ok(goalTemplateByKey('sales-org-arr-growth'), 'bookmarked links must still resolve')
  assert.ok(
    !VISIBLE_GOAL_TEMPLATES.some((entry) => entry.key === 'sales-org-arr-growth'),
    'a retired template must not render in the gallery',
  )
  render(<GoalTemplateGallery />)
  fireEvent.click(screen.getByRole('tab', { name: 'Sales' }))
  assert.equal(screen.queryByText('Grow ARR'), null)
})

test('clicking a card opens the detail dialog', async () => {
  render(<GoalTemplateGallery />)
  const template = VISIBLE_GOAL_TEMPLATES[0]
  fireEvent.click(screen.getByRole('button', { name: new RegExp(template.name) }))
  await waitFor(() => {
    assert.ok(screen.getByText(template.tracks))
  })
})

test('a failed source probe still renders the gallery', async () => {
  globalThis.fetch = (async () => { throw new Error('offline') }) as typeof fetch
  render(<GoalTemplateGallery />)
  await waitFor(() => {
    assert.equal(screen.getAllByText('View goal').length, PAGE_SIZE)
  })
})

test('the RevOps tab shows only the plays a process owner rolls out', () => {
  render(<GoalTemplateGallery />)
  fireEvent.click(screen.getByRole('tab', { name: 'RevOps' }))
  // 8 templates, one page, so every one renders.
  assert.equal(screen.getAllByText('View goal').length, 8)
  assert.equal(
    screen.queryByText('Hit my quarterly quota'),
    null,
    'a personal target is not a play',
  )
})
