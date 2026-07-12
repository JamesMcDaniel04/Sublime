import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SEED_CATALOGUE, getSeedByKey, serializeSeed } from '../catalogue'
import { flowGraphSchema } from '@/lib/flows/graph'
import { canonicalIntegrationSlug, departmentsForTools, DEPARTMENTS } from '../departments'

const KNOWN = new Set(DEPARTMENTS)
const STABLE_TOOL_PLANES = new Set(['nango', 'native']) // per-org mcp/klavis ids are forbidden in seed graphs

test('exactly 20 seeds, 4 per department bucket, unique seedKeys', () => {
  assert.equal(SEED_CATALOGUE.length, 20)
  const keys = SEED_CATALOGUE.map((s) => s.seedKey)
  assert.equal(new Set(keys).size, 20, 'seedKeys must be unique')
  for (const dept of DEPARTMENTS.filter((d) => d !== 'general')) {
    const n = SEED_CATALOGUE.filter((s) => s.departments.includes(dept)).length
    assert.ok(n >= 4, `${dept} needs >= 4 seeds, got ${n}`)
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

test('flow graphs: every agent node ref resolves to an embedded spec; no per-org connection ids', () => {
  for (const s of SEED_CATALOGUE.filter((x) => x.kind === 'flow')) {
    const refs = new Set((s.agents ?? []).map((a) => a.ref))
    for (const node of s.flowGraph!.nodes) {
      if (node.type === 'agent') {
        assert.ok(refs.has(node.data.agentId), `${s.seedKey}: agent node "${node.data.agentId}" has no spec`)
      }
      if (node.type === 'tool') {
        const [plane] = node.data.connectionId.split(':')
        assert.ok(STABLE_TOOL_PLANES.has(plane), `${s.seedKey}: tool connectionId "${node.data.connectionId}" is not a stable plane`)
      }
    }
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
