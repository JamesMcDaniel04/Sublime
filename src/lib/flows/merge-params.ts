/**
 * The Merge node's parameters, declared.
 *
 * Every field's visibility is data (`showWhen`), not an `&&` in JSX — so the
 * join keys exist for `byKey` and nowhere else, and adding a mode later means
 * adding entries rather than editing a component. See node-params.ts for the
 * three bugs that motivated this.
 */
import type { ParamSpec } from './node-params'

export const MERGE_PARAMS: ParamSpec[] = [
  {
    key: 'mode',
    label: 'How to merge',
    control: 'select',
    options: [
      { value: 'append', label: 'Append — one list after the other' },
      { value: 'byKey', label: 'Match on a field' },
      { value: 'byPosition', label: 'Pair by position' },
      { value: 'pickBranch', label: 'Take whichever branch ran' },
    ],
  },
  {
    key: 'leftKey',
    label: 'Field on the first branch',
    control: 'text',
    required: true,
    placeholder: 'id',
    showWhen: { mode: ['byKey'] },
  },
  {
    key: 'rightKey',
    label: 'Field on the second branch',
    control: 'text',
    placeholder: 'Leave blank to use the same field name',
    showWhen: { mode: ['byKey'] },
  },
  {
    key: 'join',
    label: 'Rows to keep',
    control: 'select',
    options: [
      { value: 'inner', label: 'Only rows that matched' },
      { value: 'left', label: 'All rows from the first branch' },
      { value: 'outer', label: 'All rows from both branches' },
    ],
    help: 'On a field collision the first branch wins.',
    showWhen: { mode: ['byKey'] },
  },
]
