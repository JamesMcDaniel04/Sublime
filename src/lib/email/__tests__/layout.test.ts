import { test } from 'node:test'
import assert from 'node:assert/strict'
import { escapeHtml, wrapEmailHtml } from '../layout'

test('email layout escapes shell values and renders optional controls', () => {
  assert.equal(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
  const html = wrapEmailHtml({ heading: 'Hi <you>', bodyHtml: '<p>Welcome</p>', cta: { label: 'Open', url: 'https://example.test/?a=1&b=2' }, unsubscribeUrl: 'https://example.test/unsubscribe' })
  assert.match(html, /Hi &lt;you&gt;/)
  assert.match(html, /<p>Welcome<\/p>/)
  assert.match(html, /Unsubscribe/)
  assert.doesNotMatch(html, /Hi <you>/)
})
