import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToString } from 'react-dom/server'
import { ThemeSelector, ThemeToggle } from '../theme-toggle'

test('ThemeToggle renders a labeled button without a provider (SSR-safe)', () => {
  const html = renderToString(<ThemeToggle />)
  assert.match(html, /aria-label="Toggle theme"/)
  assert.match(html, /<button/)
})

test('ThemeSelector exposes system, light, and dark choices', () => {
  const html = renderToString(<ThemeSelector />)
  assert.match(html, /role="radiogroup"/)
  assert.match(html, />System</)
  assert.match(html, />Light</)
  assert.match(html, />Dark</)
})
