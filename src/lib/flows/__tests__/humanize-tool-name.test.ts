import { test } from 'node:test'
import assert from 'node:assert/strict'
import { humanizeToolName } from '../humanize-tool-name'

test('strips a redundant provider prefix given connector context', () => {
  assert.equal(humanizeToolName('slack_post_message', 'slack'), 'Post message')
  assert.equal(humanizeToolName('gmail_send_email', 'gmail'), 'Send email')
})

test('keeps the provider segment without connector context', () => {
  assert.equal(humanizeToolName('slack_post_message'), 'Slack post message')
  assert.equal(humanizeToolName('gmail_send_email'), 'Gmail send email')
})

test('does not strip a prefix that does not match the connector', () => {
  assert.equal(humanizeToolName('slack_post_message', 'gmail'), 'Slack post message')
})

test('splits camelCase names', () => {
  assert.equal(humanizeToolName('sendEmail'), 'Send email')
  assert.equal(humanizeToolName('createCalendarEvent'), 'Create calendar event')
})

test('splits kebab-case names', () => {
  assert.equal(humanizeToolName('salesforce-update-record', 'salesforce'), 'Update record')
})

test('leaves already-clean names unchanged', () => {
  assert.equal(humanizeToolName('Post message'), 'Post message')
  assert.equal(humanizeToolName('Search'), 'Search')
})

test('never strips a single-word name down to nothing', () => {
  assert.equal(humanizeToolName('slack', 'slack'), 'Slack')
})

test('connector matching ignores case and separators', () => {
  assert.equal(humanizeToolName('Google_Drive_search_files', 'google_drive'), 'Search files')
})

test('degenerate input falls back to the raw name', () => {
  assert.equal(humanizeToolName('___'), '___')
})
