import { test } from 'node:test'
import assert from 'node:assert/strict'
import { whereHasOrgScope, assertOrgScoped, ORG_SCOPED_MODELS } from '../tenant-guard'

test('whereHasOrgScope finds organizationId at any depth', () => {
  assert.equal(whereHasOrgScope({ organizationId: 'x' }), true)
  assert.equal(whereHasOrgScope({ id: '1', organizationId: 'x' }), true)
  assert.equal(whereHasOrgScope({ AND: [{ id: '1' }, { organizationId: 'x' }] }), true)
  assert.equal(whereHasOrgScope({ run: { organizationId: 'x' } }), true) // relation filter
  assert.equal(whereHasOrgScope({ execution: { is: { organizationId: 'x' } } }), true)
  assert.equal(whereHasOrgScope({ id: '1' }), false)
  assert.equal(whereHasOrgScope(undefined), false)
  assert.equal(whereHasOrgScope(null), false)
  assert.equal(whereHasOrgScope({}), false)
})

test('assertOrgScoped throws a descriptive error for unscoped reads on org models', () => {
  assert.throws(
    () => assertOrgScoped('Flow', 'findFirst', { where: { id: 'f1' } }),
    (error: Error) =>
      error.message.includes('Flow.findFirst') &&
      error.message.includes('organizationId') &&
      error.message.includes('systemPrisma'),
  )
})

test('assertOrgScoped passes scoped queries and non-org models', () => {
  assert.doesNotThrow(() => assertOrgScoped('Flow', 'findFirst', { where: { id: 'f1', organizationId: 'o1' } }))
  assert.doesNotThrow(() => assertOrgScoped('WorkflowStep', 'findMany', { where: { executionId: 'e1' } }))
})

test('assertOrgScoped ignores non-where operations and create data', () => {
  assert.doesNotThrow(() => assertOrgScoped('Flow', 'create', { data: { name: 'f', organizationId: 'o1' } }))
})

test('ORG_SCOPED_MODELS covers the known org-carrying models', () => {
  for (const model of ['AgentTask', 'AgentExecution', 'Flow', 'FlowRun', 'Notification', 'AuditEvent', 'McpConnection', 'KnowledgeDocument']) {
    assert.ok(ORG_SCOPED_MODELS.has(model), model)
  }
  assert.ok(!ORG_SCOPED_MODELS.has('User')) // nullable orgId — bootstrap queries are org-less by design
  assert.ok(!ORG_SCOPED_MODELS.has('Organization')) // the tenant row itself
})

test('whereHasOrgScope rejects an undefined organizationId value', () => {
  assert.equal(whereHasOrgScope({ organizationId: undefined }), false)
  assert.equal(whereHasOrgScope({ id: '1', organizationId: undefined }), false)
  assert.equal(whereHasOrgScope({ organizationId: null }), true)
})

test('assertOrgScoped guards upsert and updateManyAndReturn', () => {
  assert.throws(() => assertOrgScoped('Flow', 'upsert', { where: { id: 'f1' } }))
  assert.doesNotThrow(() => assertOrgScoped('Flow', 'upsert', { where: { id: 'f1', organizationId: 'o1' } }))
  assert.throws(() => assertOrgScoped('Flow', 'updateManyAndReturn', { where: { status: 'ACTIVE' } }))
})
