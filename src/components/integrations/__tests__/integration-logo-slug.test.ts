import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeIconSlug } from '../integration-logo'
import { integrationSlug } from '../integration-chip'

test('normalizeIconSlug strips separators and lowercases', () => {
  assert.equal(normalizeIconSlug('google_calendar'), 'googlecalendar')
  assert.equal(normalizeIconSlug('google-calendar'), 'googlecalendar')
  assert.equal(normalizeIconSlug('Google Calendar'), 'googlecalendar')
})

test('normalized slug builds the expected Simple Icons CDN URL', () => {
  const slug = normalizeIconSlug('google_calendar')
  assert.equal(`https://cdn.simpleicons.org/${slug}`, 'https://cdn.simpleicons.org/googlecalendar')
})

test('template integration names resolve Granola and Figma brand marks', () => {
  assert.equal(integrationSlug('Granola'), 'granola')
  assert.equal(integrationSlug('Figma design files'), 'figma')
})
