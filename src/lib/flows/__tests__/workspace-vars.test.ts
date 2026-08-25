/**
 * Workspace variables — n8n's `$vars`.
 *
 * Every flow currently hardcodes its channel ids, thresholds and base URLs.
 * Changing one means editing every flow that mentions it, and there is no way
 * to tell which flows those are.
 *
 * Referenced as `{{workspace.<key>}}`, deliberately NOT `{{vars.<key>}}`:
 * `{{var.<name>}}` already exists and is FLOW-scoped, written by variable
 * steps. Two scopes one letter apart is a footgun that gets found in
 * production, so the workspace one gets a name that cannot be misread.
 *
 * The table stores PLAIN TEXT readable by any member. That is right for a
 * channel id and wrong for a token, so the rules below refuse
 * credential-shaped keys — otherwise this becomes a secrets store without any
 * of the vault's reveal control or rotation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeVariableKey, variableKeyProblem, workspaceVarsToken, WORKSPACE_VAR_ROOT } from '../workspace-vars'

// ── keys ────────────────────────────────────────────────────────────────────

test('a key is lowercased and trimmed', () => {
  assert.equal(normalizeVariableKey('  Slack_Channel  '), 'slack_channel')
})

// Dots would be ambiguous against the token path grammar: {{workspace.a.b}}
// could mean key "a.b" or key "a" walked into "b".
test('dots are rejected — the token grammar cannot disambiguate them', () => {
  assert.match(variableKeyProblem('sales.channel') ?? '', /dot|\./i)
})

test('a key must be an identifier, not free text', () => {
  assert.ok(variableKeyProblem('my channel'), 'spaces should be refused')
  assert.ok(variableKeyProblem('channel!'), 'punctuation should be refused')
  assert.equal(variableKeyProblem('sales_channel_id'), null)
  assert.equal(variableKeyProblem('threshold2'), null)
})

test('an empty key is refused', () => {
  assert.ok(variableKeyProblem(''))
  assert.ok(variableKeyProblem('   '))
})

test('a key is length-bounded', () => {
  assert.ok(variableKeyProblem('x'.repeat(200)))
})

// The guard that keeps this from silently becoming a secrets store.
test('credential-shaped keys are refused, with the vault named', () => {
  for (const key of ['api_key', 'apikey', 'secret', 'password', 'token', 'access_token', 'client_secret', 'private_key']) {
    const problem = variableKeyProblem(key)
    assert.ok(problem, `${key} should be refused`)
    assert.match(problem, /credential|vault/i, `${key}'s message should point at the vault`)
  }
})

// …but a key that merely CONTAINS a scary substring in an innocent way is fine.
test('an innocent key containing a scary word is still allowed', () => {
  assert.equal(variableKeyProblem('tokens_per_batch'), null)
  assert.equal(variableKeyProblem('password_reset_flow_id'), null)
})

// ── token resolution ────────────────────────────────────────────────────────

const VARS = { slack_channel: 'C123', threshold: '42' }

test('{{workspace.<key>}} reads the value', () => {
  assert.equal(workspaceVarsToken('workspace.slack_channel', VARS), 'C123')
})

test('an unknown key is undefined, not the empty string', () => {
  assert.equal(workspaceVarsToken('workspace.nope', VARS), undefined)
})

// The whole bag would leak every value into a prompt or an HTTP body.
test('the bare root does not dump every variable', () => {
  assert.equal(workspaceVarsToken('workspace', VARS), undefined)
})

test('a non-workspace path is not claimed', () => {
  assert.equal(workspaceVarsToken('var.x', VARS), undefined)
  assert.equal(workspaceVarsToken('trigger.input', VARS), undefined)
})

test('lookup is case-insensitive, matching how keys are stored', () => {
  assert.equal(workspaceVarsToken('workspace.SLACK_CHANNEL', VARS), 'C123')
})

test('the root constant is what the resolver dispatches on', () => {
  assert.equal(WORKSPACE_VAR_ROOT, 'workspace')
})
