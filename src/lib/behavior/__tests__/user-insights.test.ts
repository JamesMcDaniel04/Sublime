import { test } from 'node:test'
import assert from 'node:assert/strict'
import { userInferenceGraphParts, userPatternNodeId } from '@/lib/behavior/user-insights'

const write = {
  organizationId: 'org-1', userId: 'u-1', slug: 'seq:a>>b',
  text: 'Runs A then edits B', evidenceEventIds: ['ue-1', 'ue-2'],
}

test('pattern node is PRIVATE, owned by the user, with evidence edges to uevent nodes', () => {
  const { nodes, edges } = userInferenceGraphParts(write)
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].id, userPatternNodeId('seq:a>>b'))
  assert.equal(nodes[0].type, 'insight')
  assert.equal(nodes[0].visibility, 'private')
  assert.equal(nodes[0].ownerUserId, 'u-1')
  assert.deepEqual(
    edges.map((e) => `${e.from}-${e.rel}->${e.to}`).sort(),
    [
      `${userPatternNodeId('seq:a>>b')}-evidence->uevent:ue-1`,
      `${userPatternNodeId('seq:a>>b')}-evidence->uevent:ue-2`,
    ].sort(),
  )
})

test('no evidence → structural rejection (throws)', () => {
  assert.throws(() => userInferenceGraphParts({ ...write, evidenceEventIds: [] }), /no evidence/)
})
