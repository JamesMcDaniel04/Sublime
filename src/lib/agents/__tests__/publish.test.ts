/**
 * Draft/published config for agents.
 *
 * The deep audit's weakest-area finding: agents are LIVE ON SAVE. Editing a
 * production agent changes it mid-flight, and there is no way to work on one
 * without every scheduled and triggered run picking the change up
 * immediately. Flows have had `publishedGraph` for a long time; agents had
 * nothing equivalent.
 *
 * The compatibility rule is the design:
 *
 *   publishedConfig NULL → the agent has never been published, and runs read
 *                          the live columns. That is today's behaviour, so no
 *                          existing agent changes when this ships.
 *   publishedConfig set  → runs execute the snapshot; edits to the live
 *                          columns are a DRAFT until published again.
 *
 * An agent opts into the split by being published once. Nothing is
 * backfilled, because a silent behaviour change to every agent in every
 * workspace is worse than an opt-in.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentConfigForRun, agentDraftDiffers, snapshotAgentConfig, AGENT_CONFIG_FIELDS } from '../publish'

const live = {
  description: 'Draft description',
  objective: 'Draft objective',
  goal: 'Draft goal',
  schedule: { type: 'manual' },
  metadata: { instructions: 'draft instructions', model: 'claude-sonnet-5' },
}

const published = {
  description: 'Published description',
  objective: 'Published objective',
  goal: 'Published goal',
  schedule: { type: 'schedule', cron: '0 9 * * *' },
  metadata: { instructions: 'published instructions', model: 'claude-opus-4-8' },
}

// ── which config a run executes ─────────────────────────────────────────────

test('an unpublished agent runs its live config — no existing agent changes', () => {
  const config = agentConfigForRun({ ...live, publishedConfig: null })
  assert.equal(config.objective, 'Draft objective')
  assert.equal((config.metadata as { instructions?: string }).instructions, 'draft instructions')
})

test('a published agent runs the published snapshot, not the draft', () => {
  const config = agentConfigForRun({ ...live, publishedConfig: published })
  assert.equal(config.objective, 'Published objective')
  assert.equal((config.metadata as { instructions?: string }).instructions, 'published instructions')
})

// The whole point: editing a published agent must not reach production.
test('editing a published agent does not change what runs', () => {
  const edited = { ...live, objective: 'Edited just now', publishedConfig: published }
  assert.equal(agentConfigForRun(edited).objective, 'Published objective')
})

test('the schedule comes from the published config too', () => {
  const config = agentConfigForRun({ ...live, publishedConfig: published })
  assert.deepEqual(config.schedule, { type: 'schedule', cron: '0 9 * * *' })
})

// A malformed snapshot must not take the agent down; falling back to live is
// the same call flowSettings makes for a bad timezone.
test('a corrupt published snapshot falls back to live rather than failing', () => {
  assert.equal(agentConfigForRun({ ...live, publishedConfig: 'nonsense' }).objective, 'Draft objective')
  assert.equal(agentConfigForRun({ ...live, publishedConfig: [] }).objective, 'Draft objective')
})

// A partial snapshot (an older publish, before a field existed) must fill the
// gap from live rather than returning undefined into a prompt.
test('a partial snapshot falls back field by field', () => {
  const partial = { objective: 'Published objective' }
  const config = agentConfigForRun({ ...live, publishedConfig: partial })
  assert.equal(config.objective, 'Published objective')
  assert.equal(config.description, 'Draft description', 'missing field should come from live')
})

// ── snapshotting ────────────────────────────────────────────────────────────

test('a snapshot captures exactly the run-affecting fields', () => {
  const snapshot = snapshotAgentConfig({ ...live, status: 'ACTIVE', folder: 'ops', executionCount: 12 })
  assert.deepEqual(Object.keys(snapshot).sort(), [...AGENT_CONFIG_FIELDS].sort())
})

// Roster identity, folder and counters are not config — publishing must not
// freeze them, or moving an agent between folders would need a republish.
test('a snapshot excludes fields that are not config', () => {
  const snapshot = snapshotAgentConfig({ ...live, status: 'PAUSED', folder: 'ops', workerId: 'w1', visibility: 'private' }) as Record<string, unknown>
  for (const key of ['status', 'folder', 'workerId', 'visibility', 'executionCount']) {
    assert.equal(snapshot[key], undefined, `${key} should not be frozen by a publish`)
  }
})

// ── unsaved-changes reporting ───────────────────────────────────────────────

test('an unpublished agent reports no draft difference', () => {
  assert.equal(agentDraftDiffers({ ...live, publishedConfig: null }), false)
})

test('a published agent with no edits reports no difference', () => {
  assert.equal(agentDraftDiffers({ ...published, publishedConfig: published }), false)
})

test('a published agent with an edit reports a difference', () => {
  assert.equal(agentDraftDiffers({ ...published, objective: 'changed', publishedConfig: published }), true)
})

// Only config fields count — moving folders is not an unpublished change.
test('a non-config edit is not reported as an unpublished change', () => {
  assert.equal(
    agentDraftDiffers({ ...published, folder: 'somewhere-else', publishedConfig: published }),
    false,
  )
})
