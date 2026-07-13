import { test } from 'node:test'
import assert from 'node:assert/strict'
import { departmentsForTools, canonicalIntegrationSlug, DEPARTMENTS, PRODUCT_DEPARTMENTS } from '../departments'

test('anchor tools drive their departments; order follows DEPARTMENTS', () => {
  assert.deepEqual(departmentsForTools(['github']), ['engineering'])
  assert.deepEqual(departmentsForTools(['salesforce']), ['sales', 'finance', 'csm'])
  assert.deepEqual(departmentsForTools(['hubspot']), ['sales', 'marketing', 'csm'])
  assert.deepEqual(departmentsForTools(['granola']), ['sales', 'csm'])
  assert.deepEqual(departmentsForTools(['snowflake']), ['finance'])
})

test('multiple anchors union + dedupe in canonical order', () => {
  assert.deepEqual(departmentsForTools(['linear', 'github', 'figma']), ['engineering', 'marketing'])
})

test('glue tools never assign a department alone → general', () => {
  assert.deepEqual(departmentsForTools(['slack', 'gmail', 'notion', 'google_sheets', 'http']), ['general'])
})

test('glue tools contribute nothing when an anchor is present', () => {
  assert.deepEqual(departmentsForTools(['zendesk', 'slack', 'gmail']), ['csm'])
})

test('canonicalIntegrationSlug normalizes chip keys/labels/aliases', () => {
  assert.equal(canonicalIntegrationSlug('Slack'), 'slack')
  assert.equal(canonicalIntegrationSlug('HTTP API'), 'http')
  assert.equal(canonicalIntegrationSlug('Google Sheets'), 'google_sheets')
  assert.equal(canonicalIntegrationSlug('googlesheets'), 'google_sheets')
  assert.equal(canonicalIntegrationSlug('resend'), 'email')
  assert.equal(canonicalIntegrationSlug('mondaydotcom'), 'monday')
  assert.equal(canonicalIntegrationSlug('strata:snowflake'), 'snowflake')
})

test('DEPARTMENTS is the canonical order', () => {
  assert.deepEqual([...DEPARTMENTS], ['sales', 'engineering', 'marketing', 'finance', 'csm', 'general'])
})

test('product department tabs exclude the general fallback bucket', () => {
  assert.deepEqual([...PRODUCT_DEPARTMENTS], ['sales', 'engineering', 'marketing', 'finance', 'csm'])
})
