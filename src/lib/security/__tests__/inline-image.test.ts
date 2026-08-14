import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inlineImageDataUrl } from '../inline-image'

const schema = inlineImageDataUrl(300_000)

test('accepts the inline data URLs the clients actually produce', () => {
  for (const type of ['png', 'jpeg', 'webp']) {
    assert.equal(schema.safeParse(`data:image/${type};base64,iVBORw0KGgo=`).success, true, type)
  }
})

test('rejects an external host — an avatar is not a tracking pixel', () => {
  // The old `z.string().url()` accepted this. Rendered in an <img src>, it
  // reports every viewer's IP to whoever set it, and img-src https: in the CSP
  // cannot distinguish it from a legitimate image.
  assert.equal(schema.safeParse('https://evil.example/pixel.png').success, false)
})

test('rejects a javascript: URL', () => {
  // Zod's .url() is a `new URL()` parse, and `javascript:alert(1)` is a valid
  // URL — so the previous validator passed this.
  assert.equal(schema.safeParse('javascript:alert(1)').success, false)
})

test('rejects an SVG data URL', () => {
  // SVG is a script-bearing document format. It is not in the allowlist, and
  // this pins the reason it must not be added casually.
  assert.equal(schema.safeParse('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=').success, false)
})

test('rejects non-base64 payloads and oversized images', () => {
  assert.equal(schema.safeParse('data:image/png;base64,not base64!').success, false)
  assert.equal(schema.safeParse(`data:image/png;base64,${'A'.repeat(300_001)}`).success, false)
})
