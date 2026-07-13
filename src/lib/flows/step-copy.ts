import type { DataOp, VariableOp } from '@/lib/flows/graph'

/**
 * Shared plain-English editor copy for the variable / data-operation step
 * editors — the drawer and the expanded canvas card render the same fields and
 * must teach them with the same words.
 */

/** Placeholder for a data operation's input field — teaches the expected shape. */
export const DATA_OP_INPUT_PLACEHOLDER: Record<DataOp, string> = {
  compose: 'The value to pass along',
  parseJson: 'The JSON text to parse',
  join: 'The list to join',
  csvTable: 'The list of records to turn into a table',
  htmlTable: 'The list of records to turn into a table',
  slackMessage: 'Aggregated records or text to format for Slack',
  filterArray: 'The list to filter',
  select: 'The list to map',
}

/** One-line helper under each data operation's fields. */
export const DATA_OP_HELPER: Record<DataOp, string> = {
  compose: 'Passes the value through so later steps can reuse it under this step’s name.',
  parseJson: 'Turns JSON text into structured data so later steps can map its fields.',
  join: 'Combines the list into one text value, with the separator between items.',
  csvTable: 'Builds a CSV table from the list — columns come from the record fields.',
  htmlTable: 'Builds an HTML table from the list — columns come from the record fields.',
  slackMessage: 'Builds Slack mrkdwn fallback text plus Block Kit sections for a downstream Slack action.',
  filterArray: 'Keeps only the items where every condition passes. Conditions check each item.',
  select: 'Maps every item to a new shape — values can reference fields of the current item.',
}

/** Placeholder for a variable step's value field, per operation. */
export const VARIABLE_VALUE_PLACEHOLDER: Record<VariableOp, string> = {
  initialize: 'Starting value (optional)',
  set: 'The new value',
  increment: 'Defaults to 1',
  decrement: 'Defaults to 1',
  appendArray: 'The item to add',
  appendString: 'The text to add',
}

/** Whether a variable operation's value field is optional. */
export function variableValueOptional(op: VariableOp): boolean {
  return op === 'initialize' || op === 'increment' || op === 'decrement'
}
