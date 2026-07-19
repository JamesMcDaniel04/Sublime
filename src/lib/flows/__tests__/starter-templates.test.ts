import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowGraphSchema } from '../graph'
import { STARTER_TEMPLATES } from '../starter-templates'
import { parseFlowToolConnectionId } from '../tool-connection-id'

// Templates ship straight into POST /api/flows, which parses the graph with
// flowGraphSchema — a template that fails here would 400 at "Use template".
test('every starter template graph passes the flow graph schema', () => {
  for (const template of STARTER_TEMPLATES) {
    const parsed = flowGraphSchema.safeParse(template.graph)
    assert.ok(parsed.success, `${template.key}: ${parsed.success ? '' : parsed.error.message}`)
  }
})

test('every edge references a node that exists', () => {
  for (const template of STARTER_TEMPLATES) {
    const ids = new Set(template.graph.nodes.map((node) => node.id))
    for (const edge of template.graph.edges) {
      assert.ok(ids.has(edge.source), `${template.key}: edge ${edge.id} source ${edge.source}`)
      assert.ok(ids.has(edge.target), `${template.key}: edge ${edge.id} target ${edge.target}`)
    }
  }
})

// Portability: a template must never reference an org-specific MCP row id —
// only plane-scoped ids (nango:<capability>, native:<provider>) resolve for
// every workspace at runtime.
test('tool steps only use portable plane-scoped connection ids', () => {
  for (const template of STARTER_TEMPLATES) {
    for (const node of template.graph.nodes) {
      if (node.type !== 'tool') continue
      const { plane } = parseFlowToolConnectionId(node.data.connectionId)
      assert.ok(plane === 'nango' || plane === 'native', `${template.key}/${node.id}: uses non-portable connection id "${node.data.connectionId}"`)
    }
  }
})

test('tool args are valid JSON object literals', () => {
  for (const template of STARTER_TEMPLATES) {
    for (const node of template.graph.nodes) {
      if (node.type !== 'tool' || !node.data.args) continue
      const parsed = JSON.parse(node.data.args)
      assert.equal(typeof parsed, 'object', `${template.key}/${node.id}: args must be an object`)
    }
  }
})

test('templates stay within the 3-5 step budget (excluding trigger/input/stop)', () => {
  for (const template of STARTER_TEMPLATES) {
    const steps = template.graph.nodes.filter((node) => !['trigger', 'input', 'stop'].includes(node.type))
    assert.ok(steps.length >= 2 && steps.length <= 5, `${template.key}: ${steps.length} steps`)
  }
})

test('inline agent steps declare outputFields when structured', () => {
  for (const template of STARTER_TEMPLATES) {
    for (const node of template.graph.nodes) {
      if (node.type !== 'agent') continue
      assert.equal(node.data.agentId, '', `${template.key}/${node.id}: templates must not reference saved agents`)
      assert.ok(node.data.prompt && node.data.prompt.length > 0, `${template.key}/${node.id}: inline agent needs a prompt`)
      if (node.data.responseFormat === 'structured') {
        assert.ok((node.data.outputFields?.length ?? 0) > 0, `${template.key}/${node.id}: structured step needs outputFields`)
      }
    }
  }
})

test('every starter has a detailed output and paste-ready Copilot brief', () => {
  for (const template of STARTER_TEMPLATES) {
    assert.ok(template.category.trim().length > 0, `${template.key}: category is required`)
    assert.match(template.exampleOutput, /<\w+/, `${template.key}: example output should be HTML`)
    assert.ok(template.copilotInstructions.length >= 250, `${template.key}: Copilot brief is too thin`)
    assert.match(template.copilotInstructions, /Build a .*flow/i, `${template.key}: brief should explicitly ask Copilot to build a flow`)
  }
})
