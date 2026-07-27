import '@/test-support/jsdom-env'
import { test, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { GoalTemplateGallery } from '../goal-template-gallery'
import { GOAL_TEMPLATES } from '@/lib/goals/goal-templates'

const PAGE_SIZE = 9

beforeEach(() => {
  globalThis.fetch = (async () =>
    ({ ok: true, status: 200, json: async () => ({ sources: [] }) }) as Response) as typeof fetch
})
afterEach(cleanup)

test('shows exactly one page of templates at a time', () => {
  render(<GoalTemplateGallery />)
  assert.equal(screen.getAllByText('View goal').length, PAGE_SIZE)
})

test('paging forward shows the next slice', () => {
  render(<GoalTemplateGallery />)
  const firstName = GOAL_TEMPLATES[0].name
  assert.ok(screen.getByText(firstName))
  fireEvent.click(screen.getByRole('button', { name: /next/i }))
  assert.equal(screen.queryByText(firstName), null)
  assert.ok(screen.getByText(GOAL_TEMPLATES[PAGE_SIZE].name))
})

test('picking a department resets to page 1 and hides the pager', () => {
  render(<GoalTemplateGallery />)
  fireEvent.click(screen.getByRole('button', { name: /next/i }))
  fireEvent.click(screen.getByRole('tab', { name: 'Sales' }))
  // Nine per department means one page — the pager renders nothing.
  assert.equal(screen.queryByRole('button', { name: /next/i }), null)
  assert.equal(screen.getAllByText('View goal').length, 9)
})

test('clicking a card opens the detail dialog', async () => {
  render(<GoalTemplateGallery />)
  const template = GOAL_TEMPLATES[0]
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
