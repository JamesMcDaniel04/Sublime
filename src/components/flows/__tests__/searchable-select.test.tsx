/**
 * The connection/action picker. A bare <select> can't be searched, and a real
 * MCP catalog runs to hundreds of actions — scrolling is not a strategy.
 */
import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import { SearchableSelect } from '../searchable-select'

afterEach(() => cleanup())

const OPTIONS = [
  { value: 'send_message', label: 'send_message', hint: 'Post to a channel' },
  { value: 'list_channels', label: 'list_channels' },
  { value: 'delete_message', label: 'delete_message' },
]

test('shows the selected option label when closed', () => {
  const { getByRole } = render(
    <SearchableSelect value="list_channels" options={OPTIONS} ariaLabel="Action" onChange={() => {}} />,
  )
  assert.match(getByRole('combobox', { name: /^action$/i }).textContent ?? '', /list_channels/)
})

test('shows the placeholder when nothing is selected', () => {
  const { getByRole } = render(
    <SearchableSelect value="" options={OPTIONS} ariaLabel="Action" placeholder="Choose an action" onChange={() => {}} />,
  )
  assert.match(getByRole('combobox', { name: /^action$/i }).textContent ?? '', /choose an action/i)
})

test('filters options as you type and selects the match', () => {
  let picked: string | null = null
  const { getByRole, getByText, queryByText } = render(
    <SearchableSelect value="" options={OPTIONS} ariaLabel="Action" onChange={(value) => { picked = value }} />,
  )
  act(() => { getByRole('combobox', { name: /^action$/i }).click() })
  act(() => { fireEvent.change(getByRole('textbox'), { target: { value: 'delete' } }) })
  assert.equal(queryByText('send_message'), null, 'non-matching option must be filtered out')
  act(() => { getByText('delete_message').click() })
  assert.equal(picked, 'delete_message')
})

test('search matches the hint, not just the label', () => {
  // Users search for what an action DOES ("post") more often than its
  // snake_case id.
  const { getByRole, getByText } = render(
    <SearchableSelect value="" options={OPTIONS} ariaLabel="Action" onChange={() => {}} />,
  )
  act(() => { getByRole('combobox', { name: /^action$/i }).click() })
  act(() => { fireEvent.change(getByRole('textbox'), { target: { value: 'post to a' } }) })
  getByText('send_message')
})

test('search is case-insensitive', () => {
  const { getByRole, getByText } = render(
    <SearchableSelect value="" options={OPTIONS} ariaLabel="Action" onChange={() => {}} />,
  )
  act(() => { getByRole('combobox', { name: /^action$/i }).click() })
  act(() => { fireEvent.change(getByRole('textbox'), { target: { value: 'DELETE' } }) })
  getByText('delete_message')
})

test('says so when nothing matches', () => {
  const { getByRole, getByText } = render(
    <SearchableSelect value="" options={OPTIONS} ariaLabel="Action" onChange={() => {}} />,
  )
  act(() => { getByRole('combobox', { name: /^action$/i }).click() })
  act(() => { fireEvent.change(getByRole('textbox'), { target: { value: 'zzz' } }) })
  getByText(/no matches/i)
})

test('Escape closes without changing the value', () => {
  let changed = 0
  const { getByRole, queryByRole } = render(
    <SearchableSelect value="list_channels" options={OPTIONS} ariaLabel="Action" onChange={() => { changed++ }} />,
  )
  act(() => { getByRole('combobox', { name: /^action$/i }).click() })
  act(() => { fireEvent.keyDown(getByRole('textbox'), { key: 'Escape' }) })
  assert.equal(queryByRole('textbox'), null, 'popover should close')
  assert.equal(changed, 0)
})

test('an empty option list still opens and explains itself', () => {
  // A connection whose discovery failed has no actions — the picker must not
  // look identical to one that simply hasn't loaded.
  const { getByRole, getByText } = render(
    <SearchableSelect
      value=""
      options={[]}
      ariaLabel="Action"
      emptyLabel="No actions — reconnect this connection."
      onChange={() => {}}
    />,
  )
  act(() => { getByRole('combobox', { name: /^action$/i }).click() })
  getByText(/reconnect this connection/i)
})

test('invalid marks the trigger for assistive tech, not just colour', () => {
  // The bare <select> it replaces showed a red border; colour alone is not an
  // accessible error signal.
  const { getByRole } = render(
    <SearchableSelect value="" options={OPTIONS} ariaLabel="Action" invalid onChange={() => {}} />,
  )
  assert.equal(getByRole('combobox', { name: /^action$/i }).getAttribute('aria-invalid'), 'true')
})

test('reopening starts from a cleared search', () => {
  // A stale query would hide options the user expects to see on reopen.
  const { getByRole, getByText } = render(
    <SearchableSelect value="" options={OPTIONS} ariaLabel="Action" onChange={() => {}} />,
  )
  act(() => { getByRole('combobox', { name: /^action$/i }).click() })
  act(() => { fireEvent.change(getByRole('textbox'), { target: { value: 'delete' } }) })
  act(() => { fireEvent.keyDown(getByRole('textbox'), { key: 'Escape' }) })
  act(() => { getByRole('combobox', { name: /^action$/i }).click() })
  getByText('send_message')
})
