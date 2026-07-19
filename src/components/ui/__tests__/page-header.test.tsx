import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToString } from 'react-dom/server'
import { Bot } from 'lucide-react'
import { PageHeader } from '../page-header'

test('PageHeader renders optional icon beside the title', () => {
  const html = renderToString(<PageHeader title="Agents" icon={Bot} />)
  assert.match(html, /<svg/)
  assert.match(html, /Agents/)
})

test('PageHeader without icon renders no icon tile', () => {
  const html = renderToString(<PageHeader title="Agents" />)
  assert.doesNotMatch(html, /<svg/)
})
