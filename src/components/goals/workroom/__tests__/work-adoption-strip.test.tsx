import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen } from '@testing-library/react'
import { WorkAdoptionStrip } from '../work-adoption-strip'

afterEach(cleanup)

const funnel = (produced: number, used: number, worked = 0) => ({
  produced,
  used,
  worked,
  usedRate: produced > 0 ? used / produced : null,
  workedRate: used > 0 ? worked / used : null,
})

const stats = {
  overall: funnel(24, 17, 6),
  byAgent: [],
  byAssignee: [
    { assigneeUserId: 'u2', assigneeName: 'Sam Diaz', ...funnel(9, 7) },
    { assigneeUserId: 'u1', assigneeName: 'Dana Reed', ...funnel(8, 8) },
    { assigneeUserId: 'u3', assigneeName: 'Alex Chen', ...funnel(7, 2) },
    { assigneeUserId: null, assigneeName: 'Unassigned', ...funnel(3, 0) },
  ],
}

test('leads with the team number, not the leaderboard', () => {
  render(<WorkAdoptionStrip stats={stats} />)
  const text = screen.getByText(/24 produced/).textContent ?? ''
  assert.match(text, /17 used/)
  assert.match(text, /71%/)
})

test('shows every person who was given work, including nobody', () => {
  render(<WorkAdoptionStrip stats={stats} />)
  for (const name of ['Sam Diaz', 'Dana Reed', 'Alex Chen', 'Unassigned']) {
    assert.ok(screen.getByText(name), `${name} must appear`)
  }
})

test('never uses the language of compliance', () => {
  // This table is one design decision from a surveillance product. If it reads
  // as a narc dashboard at a 40-person revenue team it gets switched off, and
  // the disposition signal — the whole wedge — dies with it.
  const { container } = render(<WorkAdoptionStrip stats={stats} />)
  const text = container.textContent ?? ''
  for (const word of [/compliance/i, /violation/i, /\brank\b/i, /#1/, /failing/i]) {
    assert.equal(word.test(text), false, `${word} has no place in this view`)
  }
})

test('renders nothing before any work exists', () => {
  const { container } = render(
    <WorkAdoptionStrip stats={{ overall: funnel(0, 0), byAgent: [], byAssignee: [] }} />,
  )
  assert.equal(container.textContent, '')
})
