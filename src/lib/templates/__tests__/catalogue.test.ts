import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SEED_CATALOGUE, getSeedByKey, serializeSeed } from '../catalogue'
import { MULTI_TOOL_SEEDS } from '../catalogue-expansion'
import { flowGraphSchema } from '@/lib/flows/graph'
import { canonicalIntegrationSlug, departmentsForTools, DEPARTMENTS } from '../departments'

const KNOWN = new Set(DEPARTMENTS)
const STABLE_TOOL_PLANES = new Set(['nango', 'native', 'template']) // template placeholders bind to per-org Klavis ids at provision time

test('70 seeds, 14 per department bucket, unique seedKeys', () => {
  assert.equal(SEED_CATALOGUE.length, 70)
  const keys = SEED_CATALOGUE.map((s) => s.seedKey)
  assert.equal(new Set(keys).size, 70, 'seedKeys must be unique')
  for (const dept of DEPARTMENTS.filter((d) => d !== 'general')) {
    const n = SEED_CATALOGUE.filter((s) => s.departments.includes(dept)).length
    assert.equal(n, 14, `${dept} needs exactly 14 seeds, got ${n}`)
  }
})

test('expansion adds exactly 10 multi-tool templates per product department', () => {
  assert.equal(MULTI_TOOL_SEEDS.length, 50)
  for (const dept of DEPARTMENTS.filter((d) => d !== 'general')) {
    assert.equal(MULTI_TOOL_SEEDS.filter((seed) => seed.departments.includes(dept)).length, 10)
  }
  for (const seed of MULTI_TOOL_SEEDS) {
    const tools = new Set([...seed.requiredIntegrations, ...seed.recommendedIntegrations])
    assert.ok(tools.size >= 3, `${seed.seedKey} must combine at least three tools`)
    assert.equal(seed.trigger?.type, 'schedule', `${seed.seedKey} should be a recurring agent enhancer recipe`)
    assert.equal(seed.trigger?.schedule?.type, 'cron')
    assert.equal(seed.trigger?.schedule?.isActive, true)
  }
})

test('scheduled seeds use the runtime trigger.schedule contract', () => {
  const scheduled = SEED_CATALOGUE.filter((seed) => seed.trigger?.type === 'schedule')
  assert.ok(scheduled.length >= MULTI_TOOL_SEEDS.length)
  for (const seed of scheduled) {
    assert.ok(seed.trigger?.schedule?.cron, `${seed.seedKey} needs trigger.schedule.cron`)
    assert.ok(seed.trigger?.schedule?.timezone, `${seed.seedKey} needs trigger.schedule.timezone`)
    assert.equal(seed.trigger?.schedule?.isActive, true)
    assert.deepEqual(serializeSeed(seed).trigger, seed.trigger)
  }
})

test('every seed: valid departments, non-empty required∪recommended slugs canonical', () => {
  for (const s of SEED_CATALOGUE) {
    assert.ok(s.departments.length > 0 && s.departments.every((d) => KNOWN.has(d)), s.seedKey)
    for (const slug of [...s.requiredIntegrations, ...s.recommendedIntegrations]) {
      assert.equal(slug, canonicalIntegrationSlug(slug), `${s.seedKey}: ${slug} must already be canonical`)
    }
  }
})

test('every template requires Slack or Gmail delivery and exposes an executable runbook', () => {
  for (const seed of SEED_CATALOGUE) {
    assert.ok(
      seed.requiredIntegrations.includes('slack') || seed.requiredIntegrations.includes('gmail'),
      `${seed.seedKey} needs Slack or Gmail delivery`,
    )
    const instructions = serializeSeed(seed).instructions
    assert.match(instructions, /Trigger and cadence/, seed.seedKey)
    assert.match(instructions, /Delivery requirement/, seed.seedKey)
    assert.match(instructions, /Guardrails/, seed.seedKey)
    assert.match(instructions, /Output quality standard/, seed.seedKey)
    assert.match(instructions, /Final artifact contract \(match the Output Example\)/, seed.seedKey)
    assert.match(instructions, /<main class="artifact theme-/, seed.seedKey)
    assert.match(instructions, /Priority findings/, seed.seedKey)
    assert.match(instructions, /Action plan/, seed.seedKey)
    assert.match(instructions, /Evidence trail/, seed.seedKey)
  }
})

test('agent seeds have instructions; flow seeds have a schema-valid graph', () => {
  for (const s of SEED_CATALOGUE) {
    if (s.kind === 'agent') {
      assert.ok(s.instructions && s.instructions.length > 20, `${s.seedKey} needs instructions`)
    } else {
      assert.ok(s.flowGraph, `${s.seedKey} needs a flowGraph`)
      const parsed = flowGraphSchema.safeParse(s.flowGraph)
      assert.ok(parsed.success, `${s.seedKey} graph invalid: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`)
    }
  }
})

test('seed graphs never ship placeholder HTTP endpoints', () => {
  for (const seed of SEED_CATALOGUE) {
    for (const node of seed.flowGraph?.nodes ?? []) {
      assert.notEqual(node.type, 'http', `${seed.seedKey}: use a connected integration tool instead of HTTP`)
    }
    assert.ok(!seed.requiredIntegrations.includes('http'), `${seed.seedKey}: HTTP cannot be a required integration`)
  }
})

test('flow graphs: every agent node ref resolves to an embedded spec; no per-org connection ids', () => {
  for (const s of SEED_CATALOGUE.filter((x) => x.kind === 'flow')) {
    const refs = new Set((s.agents ?? []).map((a) => a.ref))
    let hasDeliveryNode = false
    for (const node of s.flowGraph!.nodes) {
      if (node.type === 'agent') {
        assert.ok(refs.has(node.data.agentId), `${s.seedKey}: agent node "${node.data.agentId}" has no spec`)
      }
      if (node.type === 'tool') {
        const [plane] = node.data.connectionId.split(':')
        assert.ok(STABLE_TOOL_PLANES.has(plane), `${s.seedKey}: tool connectionId "${node.data.connectionId}" is not a stable plane`)
        if (/slack|gmail/i.test(node.data.connectionId)) hasDeliveryNode = true
      }
    }
    assert.ok(hasDeliveryNode, `${s.seedKey}: flow graph needs a Slack or Gmail delivery node`)
  }
})

test('serializeSeed produces the list wire shape (no server-only fields)', () => {
  const wire = serializeSeed(SEED_CATALOGUE[0])
  assert.equal(wire.id, `seed:${SEED_CATALOGUE[0].seedKey}`)
  assert.equal(wire.seed, true)
  assert.equal(wire.custom, false)
  assert.equal(wire.mine, false)
  assert.equal((wire as any).flowGraph, undefined)
  assert.equal((wire as any).agents, undefined)
})

test('getSeedByKey round-trips', () => {
  assert.equal(getSeedByKey(SEED_CATALOGUE[5].seedKey)!.name, SEED_CATALOGUE[5].name)
  assert.equal(getSeedByKey('nope'), undefined)
})

test('every seed carries a real department anchor for each department it declares', () => {
  // "Tools must match roles": collect every tool slug a seed actually wires up
  // (required + recommended integrations, the top-level agent-kind integrations,
  // every embedded agent spec's integrations, and every tool/http node's connection
  // slug), then require departmentsForTools(...) to cover each declared department —
  // glue-only templates (no department anchor) must fail this.
  for (const s of SEED_CATALOGUE) {
    const slugs = new Set<string>([...s.requiredIntegrations, ...s.recommendedIntegrations, ...(s.integrations ?? [])])
    for (const a of s.agents ?? []) for (const i of a.integrations) slugs.add(i)
    if (s.flowGraph) {
      for (const node of s.flowGraph.nodes) {
        if (node.type === 'tool') slugs.add(node.data.connectionId.split(':').pop() ?? node.data.connectionId)
        if (node.type === 'http') slugs.add('http')
      }
    }
    const depts = departmentsForTools(Array.from(slugs))
    for (const dept of s.departments) {
      if (dept === 'general') continue
      assert.ok(
        depts.includes(dept),
        `${s.seedKey}: no anchor tool for department "${dept}" (slugs: [${Array.from(slugs).join(', ')}] → departments: [${depts.join(', ')}])`,
      )
    }
  }
})
