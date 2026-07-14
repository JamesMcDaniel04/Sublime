import { test } from 'node:test'
import assert from 'node:assert/strict'
import { looksLikeHtml } from '../html-preview'

test('detects real HTML documents and fragments', () => {
  assert.equal(looksLikeHtml('<!doctype html><html><body>hi</body></html>'), true)
  assert.equal(looksLikeHtml('<div style="max-width:600px"><h1>Brief</h1><table><tr><td>x</td></tr></table></div>'), true)
  assert.equal(looksLikeHtml('  <p>Hello</p> '), true)
})

test('does not trip on markdown or prose with stray tags', () => {
  assert.equal(looksLikeHtml('# Heading\n\nSome **markdown** text'), false)
  assert.equal(looksLikeHtml('Use <br> to break lines'), false)
  assert.equal(looksLikeHtml('a < b and b > c'), false)
  assert.equal(looksLikeHtml(''), false)
})

test('detects the advertised artifact by its <main> root, regardless of inner sections', () => {
  // The rich artifact always begins with `<main class="artifact …">`; detection
  // must not hinge on which inner sections (section/table/…) are present.
  assert.equal(looksLikeHtml('<main class="artifact theme-sales"><header class="hero"><span>🎯</span></header></main>'), true)
})
