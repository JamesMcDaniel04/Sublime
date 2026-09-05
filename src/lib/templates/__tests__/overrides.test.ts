import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyTemplateOverrides, overrideSchedule, templateOverridesSchema, validateOverrides } from '../overrides'
import { rewriteGraphTrigger } from '../provision-plan'
import type { FlowGraph } from '@/lib/flows/graph'

const recipe = {
  name: 'Pipeline Hygiene Nudger',
  description: 'Nudges owners.',
  instructions: 'Audit the pipeline.',
  model: 'claude-sonnet-5',
  schedule: { type: 'cron' as const, cron: '0 13 * * 1-5', time: '', timezone: 'UTC', isActive: true },
}

test('no overrides leaves the recipe untouched and reports nothing applied', () => {
  const { recipe: out, applied } = applyTemplateOverrides(recipe, undefined)
  assert.deepEqual(out, recipe)
  assert.deepEqual(applied, [])
})

test('only present, changed fields are applied and named', () => {
  const { recipe: out, applied } = applyTemplateOverrides(recipe, {
    name: 'Pipeline Hygiene Nudger', // unchanged → not applied
    instructions: 'Audit the pipeline and DM each owner.',
    model: 'claude-haiku-4-5',
  })
  assert.equal(out.name, recipe.name)
  assert.equal(out.instructions, 'Audit the pipeline and DM each owner.')
  assert.equal(out.model, 'claude-haiku-4-5')
  assert.deepEqual(out.schedule, recipe.schedule)
  assert.deepEqual(applied, ['instructions', 'model'])
})

test('an explicit empty description clears it', () => {
  const { recipe: out, applied } = applyTemplateOverrides(recipe, { description: '' })
  assert.equal(out.description, '')
  assert.deepEqual(applied, ['description'])
})

test('a manual schedule override deactivates the recipe schedule', () => {
  const { recipe: out, applied } = applyTemplateOverrides(recipe, {
    schedule: { type: 'manual', time: '', cron: '', timezone: 'UTC', isActive: true },
  })
  assert.deepEqual(out.schedule, { type: 'manual', time: '', cron: '', timezone: 'UTC', isActive: false })
  assert.deepEqual(applied, ['schedule'])
})

test('a schedule identical to the recipe is not counted as applied', () => {
  const { applied } = applyTemplateOverrides(recipe, { schedule: { ...recipe.schedule } })
  assert.deepEqual(applied, [])
})

test('overrideSchedule keeps runAt only for one-time runs', () => {
  const once = overrideSchedule({ type: 'once', time: '09:00', cron: '', timezone: 'Europe/Paris', runAt: '2026-10-01', isActive: true })
  assert.equal(once.runAt, '2026-10-01')
  const daily = overrideSchedule({ type: 'daily', time: '09:00', cron: '', timezone: '', isActive: true })
  assert.equal(daily.timezone, 'UTC')
  assert.equal('runAt' in daily, false)
})

test('validateOverrides refuses schedules that could never fire', () => {
  assert.equal(validateOverrides({}), null)
  assert.match(validateOverrides({ schedule: { type: 'cron', cron: '  ', time: '', timezone: 'UTC', isActive: true } }) ?? '', /cron/)
  assert.match(validateOverrides({ schedule: { type: 'daily', cron: '', time: '', timezone: 'UTC', isActive: true } }) ?? '', /HH:MM/)
  assert.match(validateOverrides({ schedule: { type: 'once', cron: '', time: '09:00', timezone: 'UTC', isActive: true } }) ?? '', /date/)
  assert.equal(validateOverrides({ schedule: { type: 'daily', cron: '', time: '09:30', timezone: 'UTC', isActive: true } }), null)
})

test('the schema is strict: a client cannot smuggle graph or integration edits through overrides', () => {
  assert.equal(templateOverridesSchema.safeParse({ name: 'x', flowGraph: {} }).success, false)
  assert.equal(templateOverridesSchema.safeParse({ requiredIntegrations: [] }).success, false)
  assert.equal(templateOverridesSchema.safeParse({ instructions: '' }).success, false)
  const parsed = templateOverridesSchema.parse({ name: '  Trimmed  ', schedule: { type: 'daily', time: '08:00' } })
  assert.equal(parsed.name, 'Trimmed')
  assert.equal(parsed.schedule?.timezone, 'UTC')
})

test('rewriteGraphTrigger replaces only the trigger node and never mutates the source graph', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'schedule', schedule: { type: 'cron', cron: '0 13 * * 1-5', time: '', timezone: 'UTC', isActive: true } } } },
      { id: 'a', type: 'agent', data: { agentId: 'ref', input: '{{trigger.input}}', label: 'A' } },
    ],
    edges: [{ id: 'trigger-a', source: 'trigger', target: 'a' }],
  }
  const out = rewriteGraphTrigger(graph, { type: 'manual' })
  const node = out.nodes.find((n) => n.type === 'trigger')
  assert.deepEqual(node?.type === 'trigger' ? node.data.trigger : null, { type: 'manual' })
  const original = graph.nodes.find((n) => n.type === 'trigger')
  assert.equal(original?.type === 'trigger' ? original.data.trigger.type : null, 'schedule')
  assert.equal(out.nodes[1].type, 'agent')
})
