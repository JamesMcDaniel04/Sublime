/**
 * Which tool planes may back the builder's "pick from a list" resource picker.
 *
 * The picker runs a real tool to populate a dropdown, so the ONLY thing
 * standing between it and a side effect is the refusal below plus the
 * executor's `isWrite` flag. Backstory's equivalent route denylists two planes
 * and trusts `isWrite` for the rest. Sublime's plane set is different, and
 * that denylist does not survive the translation:
 *
 *   - `flow` reports `isWrite: false` while executing an ENTIRE FLOW, which
 *     can send mail, post to Slack, write to Postgres — anything the flow does.
 *     A denylist that trusts isWrite would wave this straight through.
 *   - `postgres` reports the connection's `allowWrites` column, which is
 *     per-connection, not per-tool.
 *   - `mcp` reports `isWrite: false` for every tool regardless of behaviour.
 *
 * So this is an ALLOWLIST. A plane earns picker access by having authoritative
 * per-tool write classification, and anything unrecognised is refused.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FLOW_TOOL_PLANES } from '../tool-connection-id'
import { pickerPlaneAllowed } from '../tool-options'

test('the native plane backs a picker — its descriptors classify writes per tool', () => {
  assert.equal(pickerPlaneAllowed('native').allowed, true)
})

// The one that matters most. `flow` hardcodes isWrite:false and then runs a
// whole flow, so trusting isWrite here would turn a dropdown into an
// arbitrary-side-effect trigger.
test('the flow plane is refused even though it reports isWrite:false', () => {
  const decision = pickerPlaneAllowed('flow')
  assert.equal(decision.allowed, false)
  assert.match(decision.allowed === false ? decision.reason : '', /flow/i)
})

test('the mcp plane is refused — it cannot classify writes', () => {
  assert.equal(pickerPlaneAllowed('mcp').allowed, false)
})

// allowWrites is a property of the connection, not of the individual tool, so
// a read-only-looking call can still be arbitrary SQL.
test('the postgres plane is refused — allowWrites is per-connection, not per-tool', () => {
  assert.equal(pickerPlaneAllowed('postgres').allowed, false)
})

/**
 * The structural guarantee. A future plane added to FLOW_TOOL_PLANES must not
 * default into the picker by omission — the failure mode this whole allowlist
 * exists to prevent is a plane nobody thought about being trusted silently.
 */
test('every declared plane has an explicit decision, so a new one cannot default in', () => {
  for (const plane of FLOW_TOOL_PLANES) {
    const decision = pickerPlaneAllowed(plane)
    assert.equal(typeof decision.allowed, 'boolean', `${plane} has no decision`)
    if (decision.allowed === false) {
      assert.ok(decision.reason.length > 20, `${plane} refusal needs an operator-readable reason`)
    }
  }
})

test('an unrecognised plane is refused rather than allowed', () => {
  assert.equal(pickerPlaneAllowed('not-a-plane' as never).allowed, false)
})
