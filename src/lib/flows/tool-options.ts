/**
 * Which tool planes may back the builder's "pick from a list" resource picker.
 *
 * The picker exists so a step can offer a real dropdown — choose a Slack
 * channel, a board, a record — instead of asking someone to paste an opaque
 * id. Populating it means RUNNING a tool, which is why this file exists: the
 * only things between a dropdown and a side effect are this decision and the
 * executor's `isWrite` flag.
 *
 * It is an ALLOWLIST, deliberately. The obvious shape is a denylist that
 * refuses the planes known to misreport writes and trusts `isWrite` for the
 * rest — but in this codebase `isWrite` is not uniformly trustworthy:
 *
 *   - `flow` (tool-planes.ts) hardcodes `isWrite: false` and then executes an
 *     ENTIRE FLOW via runFlowExecution. That flow can send mail, post to
 *     Slack, write to Postgres — anything it is built to do. A denylist would
 *     admit it on a false `false`.
 *   - `postgres` reports the connection's `allowWrites` column. That is a
 *     property of the connection, not of the call, so a picker could still
 *     issue arbitrary SQL against a connection that happens to allow writes.
 *   - `mcp` reports `isWrite: false` for every tool regardless of behaviour;
 *     the optional `annotations.readOnlyHint` is advisory and often absent.
 *
 * So a plane earns picker access by having authoritative PER-TOOL write
 * classification, and anything else — including a plane added later that
 * nobody revisited — is refused.
 */
import type { FlowToolPlane } from './tool-connection-id'

export type PickerPlaneDecision =
  | { allowed: true }
  | { allowed: false; reason: string }

const ALLOWED: Readonly<Record<string, true>> = {
  // Native tool descriptors carry a per-tool `isWrite`, set alongside the
  // tool definition itself — the one plane where the flag means what it says.
  native: true,
  // Delivery capabilities. Every nango executor reports isWrite: true, so the
  // route's write check refuses each one anyway; admitting the plane here
  // keeps the user-facing message accurate ("only read actions") rather than
  // claiming the connection type is unsupported.
  nango: true,
}

const REFUSALS: Readonly<Record<string, string>> = {
  mcp: 'MCP connections report every tool as read-only, so a picker there could fire a write. Type the value instead.',
  flow: 'A flow step reports itself as read-only but executes the whole flow, which can send mail or write data. Pickers cannot run flows.',
  postgres: 'Postgres connections allow or refuse writes per connection, not per query, so a picker could run arbitrary SQL. Type the value instead.',
}

const UNKNOWN_PLANE =
  'This connection type has not been cleared for live pickers, so it cannot be used to populate a list. Type the value instead.'

/** Whether `plane` may run a tool to populate a picker, and why not if it may not. */
export function pickerPlaneAllowed(plane: FlowToolPlane): PickerPlaneDecision {
  if (ALLOWED[plane]) return { allowed: true }
  return { allowed: false, reason: REFUSALS[plane] ?? UNKNOWN_PLANE }
}

/** Most items a picker will ever return, so a large list cannot bloat a response. */
export const PICKER_ITEM_CAP = 200
