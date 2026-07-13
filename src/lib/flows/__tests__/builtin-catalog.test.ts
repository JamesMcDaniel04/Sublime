import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_GROUPS, AI_CAPABILITY_LEAVES, TRIGGER_LEAVES, searchCorpus } from '../builtin-catalog'
import { DATA_OPS, VARIABLE_OPS, emptyGraph, flowNodeSchema } from '../graph'
import { DATA_OP_LABELS } from '../data-ops'
import { insertNodeAfter } from '../mutate'

test('built-in groups cover the drill-in taxonomy', () => {
  const ids = BUILTIN_GROUPS.map((g) => g.id)
  assert.deepEqual(ids, ['http', 'control', 'data-operation', 'variable', 'human-review'])
  const control = BUILTIN_GROUPS.find((g) => g.id === 'control')!
  assert.deepEqual(control.children.map((c) => c.stepType), ['condition', 'switch', 'loop', 'parallel', 'stop'])
  const http = BUILTIN_GROUPS.find((g) => g.id === 'http')!
  assert.ok(http.children.every((c) => c.stepType === 'http'))
})

test('the Data operations group offers all seven data ops with their display labels', () => {
  const dataOp = BUILTIN_GROUPS.find((g) => g.id === 'data-operation')!
  assert.ok(dataOp.children.every((c) => c.stepType === 'data'))
  assert.deepEqual(dataOp.children.map((c) => c.seed?.dataOp), [...DATA_OPS])
  for (const leaf of dataOp.children) {
    assert.equal(leaf.label, DATA_OP_LABELS[leaf.seed!.dataOp!])
  }
})

test('the Variables group offers all six variable ops', () => {
  const variable = BUILTIN_GROUPS.find((g) => g.id === 'variable')!
  assert.ok(variable.children.every((c) => c.stepType === 'variable'))
  assert.deepEqual([...variable.children.map((c) => c.seed?.variableOp)].sort(), [...VARIABLE_OPS].sort())
})

test('the Human review group seeds a humanReview step', () => {
  const humanReview = BUILTIN_GROUPS.find((g) => g.id === 'human-review')!
  assert.deepEqual(humanReview.children.map((c) => c.stepType), ['humanReview'])
  assert.equal(humanReview.children[0].label, 'Request information')
})

test('every builtin leaf seeds a node that passes the node schema', () => {
  for (const leaf of BUILTIN_GROUPS.flatMap((g) => g.children)) {
    if (!leaf.stepType) continue
    const { graph, nodeId } = insertNodeAfter(emptyGraph(), 'trigger', leaf.stepType)
    const node = graph.nodes.find((n) => n.id === nodeId)!
    // Mirror the builder's applyInsertSeed op handling for variable/data leaves.
    const data = {
      ...node.data,
      ...(leaf.seed?.variableOp ? { op: leaf.seed.variableOp, varType: leaf.seed.variableOp === 'initialize' ? 'string' : undefined } : {}),
      ...(leaf.seed?.dataOp ? { op: leaf.seed.dataOp } : {}),
      ...(leaf.seed?.label ? { label: leaf.seed.label } : {}),
    }
    const parsed = flowNodeSchema.safeParse({ ...node, data })
    assert.ok(parsed.success, `leaf ${leaf.id} seeds an invalid ${leaf.stepType} node`)
  }
})

test('every leaf id is unique across groups, AI capabilities, and triggers', () => {
  const all = [...BUILTIN_GROUPS.flatMap((g) => g.children), ...AI_CAPABILITY_LEAVES, ...TRIGGER_LEAVES]
  assert.equal(new Set(all.map((l) => l.id)).size, all.length)
})

test('AI capabilities are action-mode agent steps', () => {
  assert.ok(AI_CAPABILITY_LEAVES.length >= 1)
  assert.ok(AI_CAPABILITY_LEAVES.every((l) => l.mode === 'action' && l.stepType === 'agent'))
})

test('trigger leaves cover all five trigger types', () => {
  assert.deepEqual(TRIGGER_LEAVES.map((l) => l.triggerType), ['manual', 'schedule', 'webhook', 'signal', 'slack'])
})

test('searchCorpus is lowercase label+description', () => {
  const leaf = TRIGGER_LEAVES[0]
  assert.equal(searchCorpus(leaf), `${leaf.label} ${leaf.description}`.toLowerCase())
})
