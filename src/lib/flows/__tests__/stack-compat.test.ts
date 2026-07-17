import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stackCompatible } from '../stack-compat'
import type { FlowGraph } from '../graph'

const agent = (id: string) => ({ id, type: 'agent' as const, data: { agentId: 'a1' } })

test('a linear chain is stack-compatible', () => {
  const graph: FlowGraph = {
    nodes: [{ id: 'trigger', type: 'trigger', data: {} }, agent('a'), agent('b')],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a' },
      { id: 'e1', source: 'a', target: 'b' },
    ],
  }
  assert.equal(stackCompatible(graph), true)
})

test('condition branches are stack-compatible (the stack view renders those)', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'cond', type: 'condition', data: { match: 'all', clauses: [{ left: 'x', op: 'contains', right: 'y' }] } },
      agent('yes'),
      agent('no'),
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'cond' },
      { id: 'e1', source: 'cond', target: 'yes', branch: 'true' },
      { id: 'e2', source: 'cond', target: 'no', branch: 'false' },
    ],
  }
  assert.equal(stackCompatible(graph), true)
})

test('fan-out (two plain wires from one node) cannot render as a stack', () => {
  const graph: FlowGraph = {
    nodes: [{ id: 'trigger', type: 'trigger', data: {} }, agent('a'), agent('b')],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a' },
      { id: 'e1', source: 'trigger', target: 'b' },
    ],
  }
  assert.equal(stackCompatible(graph), false)
})

test('fan-in (two parents converging) cannot render as a stack', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'cond', type: 'condition', data: { match: 'all', clauses: [{ left: 'x', op: 'contains', right: 'y' }] } },
      agent('yes'),
      agent('no'),
      agent('join'),
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'cond' },
      { id: 'e1', source: 'cond', target: 'yes', branch: 'true' },
      { id: 'e2', source: 'cond', target: 'no', branch: 'false' },
      // Both branch chains re-converge on one step — a shape the stack's
      // single-chain walk cannot express.
      { id: 'e3', source: 'yes', target: 'join' },
      { id: 'e4', source: 'no', target: 'join' },
    ],
  }
  assert.equal(stackCompatible(graph), false)
})
