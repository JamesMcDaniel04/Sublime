import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveAgentMention, stripBotMention } from '../route-agent'

const agents = [
  { id: 'a_riley', name: 'Riley' },
  { id: 'a_riley_scout', name: 'Riley Scout' },
  { id: 'a_update', name: 'Update' },
]

test('the bot mention is stripped before anything is matched', () => {
  assert.equal(stripBotMention('<@U0BOT9999> hello there'), 'hello there')
  assert.equal(stripBotMention('  <@U0BOT9999>   hello  '), 'hello')
  assert.equal(stripBotMention('no mention here'), 'no mention here')
})

test('@Name addresses an agent', () => {
  const hit = resolveAgentMention('<@U0BOT9999> @Riley look at the Acme renewal', agents)
  assert.deepEqual(hit, { agentId: 'a_riley', text: 'look at the Acme renewal' })
})

test('Name: addresses an agent', () => {
  const hit = resolveAgentMention('<@U0BOT9999> Riley: look at Acme', agents)
  assert.deepEqual(hit, { agentId: 'a_riley', text: 'look at Acme' })
})

test('ask Name addresses an agent', () => {
  const hit = resolveAgentMention('<@U0BOT9999> ask Riley to look at Acme', agents)
  assert.deepEqual(hit, { agentId: 'a_riley', text: 'look at Acme' })
})

test('the LONGEST matching agent name wins', () => {
  // "Riley Scout" must not be shadowed by "Riley", or the more specific
  // teammate becomes unaddressable.
  const hit = resolveAgentMention('<@U0BOT9999> @Riley Scout check the pipeline', agents)
  assert.deepEqual(hit, { agentId: 'a_riley_scout', text: 'check the pipeline' })
})

test('matching is case-insensitive', () => {
  assert.equal(resolveAgentMention('<@U0BOT9999> @riley check Acme', agents)?.agentId, 'a_riley')
  assert.equal(resolveAgentMention('<@U0BOT9999> RILEY: check Acme', agents)?.agentId, 'a_riley')
})

test('a BARE leading name does NOT address an agent', () => {
  // This is the whole collision guard. An agent named "Update" must not
  // hijack "update the board" — addressing requires an explicit marker, so
  // existing flow triggers keep working exactly as before.
  assert.equal(resolveAgentMention('<@U0BOT9999> Update the board', agents), null)
  assert.equal(resolveAgentMention('<@U0BOT9999> Riley should probably look at this', agents), null)
})

test('naming an agent with no actual request is not a request', () => {
  // "@Riley" alone is someone getting an agent's attention, not asking for
  // work. Starting a run on it would burn a run to produce nothing.
  assert.equal(resolveAgentMention('<@U0BOT9999> @Riley', agents), null)
  assert.equal(resolveAgentMention('<@U0BOT9999> Riley:', agents), null)
  assert.equal(resolveAgentMention('<@U0BOT9999> ask Riley', agents), null)
})

test('an unknown name does not match', () => {
  assert.equal(resolveAgentMention('<@U0BOT9999> @Nobody do something', agents), null)
})

test('a message with no agent name falls through', () => {
  assert.equal(resolveAgentMention('<@U0BOT9999> what is the status of Acme?', agents), null)
})

test('an empty roster never matches', () => {
  assert.equal(resolveAgentMention('<@U0BOT9999> @Riley do it', []), null)
})

test('regex-special characters in an agent name are matched literally', () => {
  // Agent names are user-authored, so a name like "C++ Helper" must not be
  // compiled into a regex that either throws or matches the wrong thing.
  const odd = [{ id: 'a_odd', name: 'C++ (Helper)' }]
  const hit = resolveAgentMention('<@U0BOT9999> @C++ (Helper) review this', odd)
  assert.deepEqual(hit, { agentId: 'a_odd', text: 'review this' })
})

test('a name that is only punctuation or blank is ignored', () => {
  assert.equal(resolveAgentMention('<@U0BOT9999> @  do something', [{ id: 'a_blank', name: '   ' }]), null)
})
