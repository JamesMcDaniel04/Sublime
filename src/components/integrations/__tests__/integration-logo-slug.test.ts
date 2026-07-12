import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeIconSlug } from '../integration-logo'
import { fromKlavisAgentType } from '@/lib/connectors/registry'
import { PROVIDERS } from '@/lib/mcp/provider-capabilities'

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
  assert.deepEqual(fromKlavisAgentType('POSTHOG'), {
    key: 'posthog',
    label: 'PostHog',
    slug: 'posthog',
  })
  assert.deepEqual(fromKlavisAgentType('YOUTUBE'), {
    key: 'youtube',
    label: 'YouTube',
    slug: 'youtube',
  })
  assert.deepEqual(fromKlavisAgentType('GITLAB'), {
    key: 'gitlab',
    label: 'GitLab',
    slug: 'gitlab',
  })
  assert.deepEqual(fromKlavisAgentType('ZENDESK'), {
    key: 'zendesk',
    label: 'Zendesk',
    slug: 'zendesk',
  })
  assert.ok(PROVIDERS.includes('zendesk'), 'Zendesk must remain an available integration option')
  assert.deepEqual(fromKlavisAgentType('MICROSOFT_TEAMS'), {
    key: 'microsoft_teams',
    label: 'Microsoft Teams',
    slug: 'microsoftteams',
  })
  assert.ok(PROVIDERS.includes('microsoft_teams'), 'Microsoft Teams must remain an available integration option')
  assert.deepEqual(fromKlavisAgentType('HUGGING_FACE'), {
    key: 'hugging_face',
    label: 'Hugging Face',
    slug: 'huggingface',
  })
  assert.ok(PROVIDERS.includes('hugging_face'), 'Hugging Face must remain an available integration option')
  assert.deepEqual(fromKlavisAgentType('AMPLITUDE'), {
    key: 'amplitude',
    label: 'Amplitude',
    slug: 'amplitude',
  })
  assert.ok(PROVIDERS.includes('amplitude'), 'Amplitude must remain an available integration option')
})
