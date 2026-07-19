import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToString } from 'react-dom/server'
import { ThemeToggle } from '../theme-toggle'

test('ThemeToggle renders a labeled button without a provider (SSR-safe)', () => {
  const html = renderToString(<ThemeToggle />)
  assert.match(html, /aria-label="Toggle theme"/)
  assert.match(html, /<button/)
})
