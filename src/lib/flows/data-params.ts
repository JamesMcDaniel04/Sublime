/**
 * The data node's scalar parameters, declared.
 *
 * This is the proof case for declarative node params (see node-params.ts).
 * The data node was chosen because it is the worst offender: twelve
 * operations sharing one flat optional config bag, with the panel
 * hand-branching on `op` for four of them. Two of the fields that fell
 * through the gap — `count` and `field` — are declared here.
 *
 * `showWhen` carries the same meaning n8n's `displayOptions.show` does, so a
 * field belongs to an operation as DATA rather than as an `&&` in JSX.
 *
 * Composite editors (clause rows, name/value rows) and the token-aware Input
 * are deliberately absent; data-params-coverage.test.ts records why for every
 * key that is not here.
 */
import type { ParamSpec } from './node-params'
import { AGGREGATIONS } from './data-ops'

export const DATA_PARAMS: ParamSpec[] = [
  {
    key: 'separator',
    label: 'Join with',
    control: 'text',
    placeholder: 'Defaults to a comma',
    showWhen: { op: ['join'] },
  },
  {
    key: 'schema',
    label: 'Schema',
    control: 'textarea',
    placeholder: 'A JSON Schema describing the parsed shape',
    help: 'Optional — stored for reference.',
    showWhen: { op: ['parseJson'] },
  },
  {
    key: 'count',
    label: 'Items to keep',
    control: 'number',
    // Mirrors the executor's clamp in data-ops.ts. A control that accepts a
    // value the run rewrites is worse than no control at all.
    min: 1,
    max: 10000,
    required: true,
    placeholder: '10',
    help: 'Keeps the first N items. Defaults to 10.',
    showWhen: { op: ['limit'] },
  },
  {
    key: 'field',
    label: 'List field',
    control: 'text',
    placeholder: 'Leave blank if the input is already a list',
    help: 'The list-bearing field to fan out on. Other fields are carried onto each item.',
    showWhen: { op: ['splitOut'] },
  },
  {
    key: 'field',
    label: 'Group by',
    control: 'text',
    placeholder: 'Leave blank to total the whole list',
    help: 'Grouping returns one row per distinct value, with the group field included.',
    showWhen: { op: ['aggregate'] },
  },
]

/**
 * Aggregation function options, shared by the aggregate editor.
 *
 * Exported from here rather than inlined so the label for a function has one
 * definition — the same reason DATA_OP_LABELS lives in step-copy.ts.
 */
export const AGGREGATION_OPTIONS: { value: string; label: string }[] = [
  { value: 'count', label: 'Count' },
  { value: 'sum', label: 'Sum' },
  { value: 'avg', label: 'Average' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
  { value: 'unique', label: 'Distinct' },
  { value: 'concat', label: 'Join text' },
]

// A misspelt or dropped aggregation would render an empty select rather than
// failing, so the two lists are pinned to each other at module load.
if (AGGREGATION_OPTIONS.length !== AGGREGATIONS.length) {
  throw new Error('AGGREGATION_OPTIONS is out of step with AGGREGATIONS in data-ops.ts')
}
