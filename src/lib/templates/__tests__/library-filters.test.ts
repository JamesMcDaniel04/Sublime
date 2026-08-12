import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_FILTER,
  categoriesOf,
  departmentsFor,
  hasCategory,
  hasDepartment,
  matchesLibraryFilters,
  matchesSearch,
} from '../library-filters'

test('a stored departments array is authoritative and is not second-guessed', () => {
  // A seed row states its audience; keyword inference must not widen it, even
  // though "pipeline" in the category would otherwise imply sales.
  assert.deepEqual(
    departmentsFor({ departments: ['engineering'], category: 'Pipeline & Forecasting' }),
    ['engineering'],
  )
})

test('stored departments are returned in canonical order, not input order', () => {
  assert.deepEqual(departmentsFor({ departments: ['csm', 'sales'] }), ['sales', 'csm'])
})

test('the general fallback never survives as a filterable department', () => {
  // departmentsForTools returns ['general'] when no anchor tool matches; that
  // is "unclassified", not a department someone can filter by.
  assert.deepEqual(departmentsFor({ departments: ['general'], integrations: ['slack'] }), [])
})

test('departments derive from anchor integrations when none are stored', () => {
  assert.deepEqual(departmentsFor({ integrations: ['github'] }), ['engineering'])
  // salesforce anchors three departments at once.
  assert.deepEqual(departmentsFor({ requiredIntegrations: ['salesforce'] }), ['sales', 'finance', 'csm'])
})

test('glue integrations alone never assign a department', () => {
  assert.deepEqual(departmentsFor({ integrations: ['slack', 'gmail', 'google_sheets'] }), [])
})

test('departments derive from classification text when integrations say nothing', () => {
  assert.deepEqual(departmentsFor({ category: 'Customer Success' }), ['csm'])
  assert.deepEqual(departmentsFor({ tags: ['renewal'] }), ['csm'])
  // Skills state their reader in job titles.
  assert.deepEqual(departmentsFor({ audience: ['RevOps'] }), ['sales'])
})

test('integration and keyword signals union rather than override', () => {
  assert.deepEqual(
    departmentsFor({ integrations: ['github'], category: 'Campaign Ops' }),
    ['engineering', 'marketing'],
  )
})

test('the description never classifies an item', () => {
  // The whole point of the split: prose that mentions marketing does not make
  // a marketing template, or the filter means nothing.
  assert.deepEqual(departmentsFor({ description: 'Sends the marketing team a summary' }), [])
})

test('keyword matching is whole-word', () => {
  // "it" inside "with", "ae" inside "aggregate" — both must not fire.
  assert.deepEqual(departmentsFor({ category: 'Working with data aggregates' }).includes('sales'), false)
  assert.deepEqual(departmentsFor({ tags: ['monitoring'] }), [])
})

test('an unclassifiable item is reachable only under All departments', () => {
  const orphan = { name: 'Untitled', category: 'Custom' }
  assert.deepEqual(departmentsFor(orphan), [])
  assert.equal(hasDepartment(orphan, ALL_FILTER), true)
  assert.equal(hasDepartment(orphan, 'sales'), false)
})

test('search matches the description even though classification does not', () => {
  const item = { name: 'Weekly digest', description: 'Summarises churn risk' }
  assert.equal(matchesSearch(item, 'churn'), true)
  assert.equal(departmentsFor(item).length, 0)
})

test('search terms AND together so each word narrows', () => {
  const item = { name: 'Renewal digest', description: 'Weekly summary for CSMs' }
  assert.equal(matchesSearch(item, 'renewal weekly'), true)
  assert.equal(matchesSearch(item, 'renewal quarterly'), false)
})

test('search is substring so it narrows as the user types', () => {
  assert.equal(matchesSearch({ name: 'Renewal digest' }, 'renew'), true)
})

test('an empty search admits everything', () => {
  assert.equal(matchesSearch({ name: 'Anything' }, ''), true)
  assert.equal(matchesSearch({ name: 'Anything' }, '   '), true)
})

test('category matching is exact and case-insensitive, not substring', () => {
  assert.equal(hasCategory({ category: 'Customer Success' }, 'customer success'), true)
  // A substring match would make "Success" select "Customer Success" too.
  assert.equal(hasCategory({ category: 'Customer Success' }, 'Success'), false)
  assert.equal(hasCategory({ category: 'Customer Success' }, ALL_FILTER), true)
})

test('categoriesOf derives the dropdown from the rows, deduped and sorted', () => {
  assert.deepEqual(
    categoriesOf([
      { category: 'Sales' },
      { category: 'customer success' },
      { category: 'Customer Success' },
      { category: '  ' },
      {},
    ]),
    ['customer success', 'Sales'],
  )
})

test('the three filters compose', () => {
  const item = { name: 'Renewal watch', category: 'Customer Success', integrations: ['zendesk'] }
  assert.equal(matchesLibraryFilters(item, { search: 'renewal', category: 'Customer Success', department: 'csm' }), true)
  assert.equal(matchesLibraryFilters(item, { search: 'renewal', category: 'Customer Success', department: 'sales' }), false)
  assert.equal(matchesLibraryFilters(item, { search: 'invoice', category: 'Customer Success', department: 'csm' }), false)
  assert.equal(matchesLibraryFilters(item, { search: '', category: ALL_FILTER, department: ALL_FILTER }), true)
})
