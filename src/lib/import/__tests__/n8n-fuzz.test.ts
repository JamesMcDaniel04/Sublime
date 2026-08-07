/**
 * Property test for the n8n converter: for ANY structurally plausible n8n
 * workflow — random node types, random wiring (including ai_* attachments,
 * multi-trigger splits, cycles, junk params, pinData) — fromN8nWorkflow must
 * either throw FlowImportError or return graphs that pass flowGraphSchema.
 * It must never throw anything else and never emit an invalid graph: the
 * surgery passes (loop absorption, error shields, expression extraction,
 * env-var splicing) have grown enough that example-based tests alone can't
 * cover their interactions.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowGraphSchema } from '@/lib/flows/graph'
import { fromN8nWorkflow } from '../n8n'
import { FlowImportError, type ImportedFlow } from '../types'

/** Deterministic PRNG (mulberry32) — failures reproduce by seed. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NODE_TYPES = [
  'n8n-nodes-base.webhook', 'n8n-nodes-base.manualTrigger', 'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.if', 'n8n-nodes-base.switch', 'n8n-nodes-base.filter',
  'n8n-nodes-base.set', 'n8n-nodes-base.code', 'n8n-nodes-base.httpRequest',
  'n8n-nodes-base.merge', 'n8n-nodes-base.noOp', 'n8n-nodes-base.stickyNote',
  'n8n-nodes-base.splitInBatches', 'n8n-nodes-base.wait', 'n8n-nodes-base.stopAndError',
  'n8n-nodes-base.respondToWebhook', 'n8n-nodes-base.slack', 'n8n-nodes-base.gmail',
  'n8n-nodes-base.googleSheets', 'n8n-nodes-base.googleDocs', 'n8n-nodes-base.limit',
  'n8n-nodes-base.sort', 'n8n-nodes-base.renameKeys', 'n8n-nodes-base.executeWorkflow',
  '@n8n/n8n-nodes-langchain.agent', '@n8n/n8n-nodes-langchain.lmChatAnthropic',
  '@n8n/n8n-nodes-langchain.memoryBufferWindow', 'n8n-nodes-base.gmailTool',
  '@n8n/n8n-nodes-langchain.toolHttpRequest', '@n8n/n8n-nodes-langchain.mcpClientTool',
]

const PARAM_VALUES: unknown[] = [
  'plain', 42, true, null, undefined,
  '={{ $json.field }}', "={{ $('Other').first().json.x }}", '={{ $env.BASE_URL }}/path',
  '={{ JSON.stringify($json) }}', '={{ $now.toISO() }}',
  { nested: '={{ $json.deep }}' }, ['a', '={{ $json.b }}'],
  { __rl: true, mode: 'id', value: 'some-id' },
  { conditions: { combinator: 'and', conditions: [{ leftValue: '={{ $json.x }}', rightValue: 1, operator: { type: 'number', operation: 'larger' } }] } },
  { assignments: { assignments: [{ name: 'k', value: '={{ $json.v }}' }] } },
]

function randomWorkflow(seed: number) {
  const random = mulberry32(seed)
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)]
  const count = 3 + Math.floor(random() * 12)
  const nodes = Array.from({ length: count }, (_unused, index) => {
    const parameters: Record<string, unknown> = {}
    const paramCount = Math.floor(random() * 4)
    for (let p = 0; p < paramCount; p += 1) {
      parameters[pick(['url', 'method', 'text', 'jsCode', 'jsonBody', 'options', 'conditions', 'assignments', 'model', 'rule', 'weird'])] = pick(PARAM_VALUES)
    }
    return {
      id: `n${index}`,
      name: `Node ${index}`,
      type: pick(NODE_TYPES),
      typeVersion: pick([1, 2, 2.1, 3.1, 4.2]),
      position: [index * 100, Math.floor(random() * 300)] as [number, number],
      parameters,
      ...(random() < 0.15 ? { onError: pick(['continueRegularOutput', 'continueErrorOutput', 'stopWorkflow']) } : {}),
      ...(random() < 0.1 ? { disabled: true } : {}),
    }
  })
  const connections: Record<string, unknown> = {}
  for (const node of nodes) {
    if (random() < 0.3) continue
    const outputs = 1 + Math.floor(random() * 2)
    const main = Array.from({ length: outputs }, () => {
      const links = Math.floor(random() * 2)
      return Array.from({ length: links }, () => ({ node: pick(nodes).name, type: 'main', index: 0 }))
    })
    const entry: Record<string, unknown> = { main }
    if (random() < 0.2) {
      entry[pick(['ai_languageModel', 'ai_tool', 'ai_memory'])] = [[{ node: pick(nodes).name, type: 'ai_tool', index: 0 }]]
    }
    connections[node.name] = entry
  }
  return {
    name: `Fuzz ${seed}`,
    nodes,
    connections,
    ...(random() < 0.2 ? { pinData: { [pick(nodes).name]: [{ json: { sample: seed } }] } } : {}),
  }
}

test('random n8n workflows always convert to schema-valid graphs or a typed error', () => {
  let converted = 0
  for (let seed = 1; seed <= 150; seed += 1) {
    const workflow = randomWorkflow(seed)
    let result: ImportedFlow
    try {
      result = fromN8nWorkflow(JSON.parse(JSON.stringify(workflow)))
    } catch (error) {
      assert.ok(error instanceof FlowImportError, `seed ${seed}: threw ${String(error)}`)
      continue
    }
    converted += 1
    for (const flow of [result, ...(result.additionalFlows ?? [])]) {
      const parsed = flowGraphSchema.safeParse(flow.graph)
      assert.ok(parsed.success, `seed ${seed}: invalid graph — ${parsed.success ? '' : parsed.error.issues[0]?.message}`)
      // Exactly one trigger with the canonical id, always.
      const triggers = flow.graph.nodes.filter((node) => node.type === 'trigger')
      assert.equal(triggers.length, 1, `seed ${seed}: ${triggers.length} triggers`)
      assert.equal(triggers[0].id, 'trigger', `seed ${seed}: trigger id ${triggers[0].id}`)
    }
  }
  assert.ok(converted >= 100, `expected most seeds to convert (got ${converted}/150)`)
})

test('oversized workflows are rejected with a typed error', () => {
  const nodes = Array.from({ length: 301 }, (_unused, index) => ({
    id: `n${index}`, name: `N${index}`, type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [0, 0] as [number, number], parameters: {},
  }))
  assert.throws(() => fromN8nWorkflow({ nodes, connections: {} }), (error: unknown) =>
    error instanceof FlowImportError && /limit is 300/.test(error.message))
})
