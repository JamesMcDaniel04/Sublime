import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeIconSlug } from '../integration-logo'
import { fromKlavisAgentType } from '@/lib/connectors/registry'

test('normalizeIconSlug strips separators and lowercases', () => {
  assert.equal(normalizeIconSlug('google_calendar'), 'googlecalendar')
  assert.equal(normalizeIconSlug('google-calendar'), 'googlecalendar')
  assert.equal(normalizeIconSlug('Google Calendar'), 'googlecalendar')
})

test('normalized slug builds the expected Simple Icons CDN URL', () => {
  const slug = normalizeIconSlug('google_calendar')
  assert.equal(`https://cdn.simpleicons.org/${slug}`, 'https://cdn.simpleicons.org/googlecalendar')
})

test('fromKlavisAgentType resolves label + slug for newly authorized apps', () => {
  assert.deepEqual(fromKlavisAgentType('GOOGLE_CALENDAR'), {
    key: 'google_calendar',
    label: 'Google Calendar',
    slug: 'googlecalendar',
  })
  assert.deepEqual(fromKlavisAgentType('SUPABASE'), {
    key: 'supabase',
    label: 'Supabase',
    slug: 'supabase',
  })
  assert.deepEqual(fromKlavisAgentType('FIGMA'), {
    key: 'figma',
    label: 'Figma',
    slug: 'figma',
  })
  assert.deepEqual(fromKlavisAgentType('SNOWFLAKE'), {
    key: 'snowflake',
    label: 'Snowflake',
    slug: 'snowflake',
  })
})
