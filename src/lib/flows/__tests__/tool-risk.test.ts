import { test } from 'node:test'
import assert from 'node:assert/strict'
import { riskForTool } from '../tool-catalog'

test('a readOnlyHint annotation classifies a tool as read', () => {
  assert.equal(riskForTool('list_items', false, { readOnlyHint: true }), 'read')
})

test('a destructiveHint annotation classifies a tool as destructive despite a benign name', () => {
  assert.equal(riskForTool('get_item', false, { destructiveHint: true }), 'destructive')
})

test('readOnlyHint: false marks a benign-named tool as write', () => {
  assert.equal(riskForTool('fetch_report', false, { readOnlyHint: false }), 'write')
})

test('without annotations the name heuristic applies', () => {
  assert.equal(riskForTool('delete_user', false), 'destructive')
  assert.equal(riskForTool('create_ticket', false), 'write')
  assert.equal(riskForTool('get_ticket', false), 'read')
  assert.equal(riskForTool('get_ticket', true), 'write')
})

test('on conflicting signals the riskier classification wins', () => {
  assert.equal(riskForTool('delete_records', false, { readOnlyHint: true }), 'destructive')
  assert.equal(riskForTool('send_message', false, { readOnlyHint: true }), 'write')
  assert.equal(riskForTool('get_item', true, { readOnlyHint: true }), 'write')
})
