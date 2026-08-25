import type { StepType } from '@/lib/flows/mutate'
import type { DataOp, VariableOp } from '@/lib/flows/graph'

/** One pickable item in the Add-trigger/Add-action catalog. */
export type PickerLeaf = {
  id: string
  label: string
  description: string
  mode: 'action' | 'trigger' | 'both'
  stepType?: StepType
  seed?: { agentId?: string; connectionId?: string; toolName?: string; label?: string; variableOp?: VariableOp; dataOp?: DataOp }
  triggerType?: 'manual' | 'schedule' | 'webhook' | 'signal' | 'slack' | 'activity'
}

export type PickerGroup = {
  id: string
  label: string
  description: string
  mode: 'action' | 'trigger' | 'both'
  children: PickerLeaf[]
}

/** Built-in tool groups with MS-style drill-in. */
export const BUILTIN_GROUPS: PickerGroup[] = [
  {
    id: 'http',
    label: 'HTTP',
    description: 'Call APIs and webhooks with full request control.',
    mode: 'action',
    children: [
      { id: 'http-request', label: 'HTTP', description: 'Send a request to any API endpoint and use the response.', mode: 'action', stepType: 'http' },
      { id: 'http-webhook-out', label: 'HTTP Webhook', description: 'Post a payload to an external webhook URL.', mode: 'action', stepType: 'http', seed: { label: 'Webhook' } },
      { id: 'http-webhook-response', label: 'Respond to webhook', description: 'Return a custom status, headers, and body to the webhook caller.', mode: 'action', stepType: 'respondWebhook' },
    ],
  },
  {
    id: 'control',
    label: 'Control',
    description: 'Branch, loop, and stop the flow.',
    mode: 'action',
    children: [
      { id: 'control-condition', label: 'Condition', description: 'Route down different paths based on a rule.', mode: 'action', stepType: 'condition' },
      { id: 'control-switch', label: 'Switch', description: 'Route to one of several cases, with a default path.', mode: 'action', stepType: 'switch' },
      { id: 'control-filter', label: 'Filter', description: 'Continue only when the data matches your conditions.', mode: 'action', stepType: 'filter' },
      { id: 'control-loop', label: 'For each', description: 'Run steps once for every item in a list.', mode: 'action', stepType: 'loop' },
      { id: 'control-repeat-until', label: 'Repeat until', description: 'Repeat steps until a rule matches, with safe run limits.', mode: 'action', stepType: 'repeatUntil' },
      { id: 'control-wait', label: 'Wait', description: 'Delay the next step for a configured duration.', mode: 'action', stepType: 'wait' },
      { id: 'control-subflow', label: 'Run workflow', description: 'Call another workflow and use its output.', mode: 'action', stepType: 'subflow' },
      { id: 'control-input', label: 'Input', description: 'Declare the typed inputs this workflow accepts when another workflow calls it.', mode: 'action', stepType: 'input' },
      { id: 'control-output', label: 'Output', description: 'Declare the fields this workflow returns to its caller.', mode: 'action', stepType: 'output' },
      { id: 'control-parallel', label: 'Parallel branches', description: 'Run independent branches at the same time.', mode: 'action', stepType: 'parallel' },
      { id: 'control-stop', label: 'Stop flow', description: 'End the flow early with an optional message.', mode: 'action', stepType: 'stop' },
    ],
  },
  {
    id: 'data-operation',
    label: 'Data operations',
    description: 'Shape, parse, and filter data between steps.',
    mode: 'action',
    children: [
      { id: 'data-set-fields', label: 'Set fields', description: 'Compose an object of named fields from earlier step data.', mode: 'action', stepType: 'transform' },
      { id: 'data-compose', label: 'Compose', description: 'Pass a value through so later steps can reuse it.', mode: 'action', stepType: 'data', seed: { dataOp: 'compose' } },
      { id: 'data-parse-json', label: 'Parse JSON', description: 'Turn JSON text into structured data for later steps.', mode: 'action', stepType: 'data', seed: { dataOp: 'parseJson' } },
      { id: 'data-join', label: 'Join', description: 'Combine a list into one text value with a separator.', mode: 'action', stepType: 'data', seed: { dataOp: 'join' } },
      { id: 'data-csv-table', label: 'Create CSV table', description: 'Turn a list of records into a CSV table.', mode: 'action', stepType: 'data', seed: { dataOp: 'csvTable' } },
      { id: 'data-html-table', label: 'Create HTML table', description: 'Turn a list of records into an HTML table.', mode: 'action', stepType: 'data', seed: { dataOp: 'htmlTable' } },
      { id: 'data-slack-message', label: 'Format Slack message', description: 'Turn aggregated records into mrkdwn fallback text and Block Kit sections.', mode: 'action', stepType: 'data', seed: { dataOp: 'slackMessage' } },
      { id: 'data-filter-array', label: 'Filter array', description: 'Keep only the list items that match your conditions.', mode: 'action', stepType: 'data', seed: { dataOp: 'filterArray' } },
      { id: 'data-select', label: 'Select', description: 'Map each list item to a new shape with the fields you choose.', mode: 'action', stepType: 'data', seed: { dataOp: 'select' } },
      { id: 'data-sort', label: 'Sort items', description: 'Order a list by one or more fields, ascending or descending.', mode: 'action', stepType: 'data', seed: { dataOp: 'sort' } },
      { id: 'data-limit', label: 'Limit items', description: 'Keep only the first N items of a list.', mode: 'action', stepType: 'data', seed: { dataOp: 'limit' } },
      { id: 'data-dedupe', label: 'Remove duplicates', description: 'Drop repeated items, comparing whole items or chosen fields.', mode: 'action', stepType: 'data', seed: { dataOp: 'dedupe' } },
      { id: 'data-split-out', label: 'Split out a field', description: 'Fan a list-bearing field out into one item per element.', mode: 'action', stepType: 'data', seed: { dataOp: 'splitOut' } },
      { id: 'data-aggregate', label: 'Aggregate', description: 'Reduce a list to totals — count, sum, average, min, max. Group by a field for one row per group.', mode: 'action', stepType: 'data', seed: { dataOp: 'aggregate' } },
    ],
  },
  {
    id: 'variable',
    label: 'Variables',
    description: 'Declare and update named values shared across the flow.',
    mode: 'action',
    children: [
      { id: 'variable-initialize', label: 'Initialize variable', description: 'Declare a named, typed value before other steps use it.', mode: 'action', stepType: 'variable', seed: { variableOp: 'initialize' } },
      { id: 'variable-set', label: 'Set variable', description: 'Replace the value of a variable initialized earlier.', mode: 'action', stepType: 'variable', seed: { variableOp: 'set' } },
      { id: 'variable-increment', label: 'Increment variable', description: 'Add to a number variable — by 1 unless you set an amount.', mode: 'action', stepType: 'variable', seed: { variableOp: 'increment' } },
      { id: 'variable-decrement', label: 'Decrement variable', description: 'Subtract from a number variable — by 1 unless you set an amount.', mode: 'action', stepType: 'variable', seed: { variableOp: 'decrement' } },
      { id: 'variable-append-array', label: 'Append to array variable', description: 'Add an item to the end of an array variable.', mode: 'action', stepType: 'variable', seed: { variableOp: 'appendArray' } },
      { id: 'variable-append-string', label: 'Append to string variable', description: 'Add text to the end of a string variable.', mode: 'action', stepType: 'variable', seed: { variableOp: 'appendString' } },
    ],
  },
  {
    id: 'human-review',
    label: 'Human review',
    description: 'Pause the flow and ask a person.',
    mode: 'action',
    children: [
      { id: 'human-review-request', label: 'Request information', description: 'Pause the flow, ask someone a question, and use their reply in later steps.', mode: 'action', stepType: 'humanReview' },
    ],
  },
]

/** AI capabilities shown first in action mode. */
// 'Run a prompt' (inline, no saved agent) returns when prompt-mode exists in the graph schema.
export const AI_CAPABILITY_LEAVES: PickerLeaf[] = [
  { id: 'ai-run-agent', label: 'Run an agent', description: 'Run one of your agents and pass its response to the next step.', mode: 'action', stepType: 'agent' },
]

/** Trigger-mode top level: the four ways a flow can start. */
export const TRIGGER_LEAVES: PickerLeaf[] = [
  { id: 'trigger-manual', label: 'Manually trigger a flow', description: 'Start it from the builder or with typed inputs.', mode: 'trigger', triggerType: 'manual' },
  { id: 'trigger-schedule', label: 'Schedule', description: 'Run on a recurrence you define.', mode: 'trigger', triggerType: 'schedule' },
  { id: 'trigger-webhook', label: 'When an HTTP request is received', description: 'Start when an external system posts to a secret URL.', mode: 'trigger', triggerType: 'webhook' },
  { id: 'trigger-signal', label: 'When a signal fires', description: 'Start from an in-platform event, like another flow completing.', mode: 'trigger', triggerType: 'signal' },
  { id: 'trigger-slack', label: 'When a Slack message arrives', description: 'Start from mentions, DMs, channel messages, or slash commands.', mode: 'trigger', triggerType: 'slack' },
  { id: 'trigger-activity', label: 'When connected activity occurs', description: 'Start from normalized activity emitted by connected tools.', mode: 'trigger', triggerType: 'activity' },
]

export function searchCorpus(leaf: PickerLeaf): string {
  return `${leaf.label} ${leaf.description}`.toLowerCase()
}
