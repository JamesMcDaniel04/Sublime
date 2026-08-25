import type { ParamSpec } from './node-params'

/**
 * The Vector node's parameters, declared.
 *
 * Visibility is data (`showWhen`), not an `&&` in JSX: a search shows a query
 * and a result count, an upsert shows the documents and which fields carry the
 * id and the text. Nothing that belongs to another mode is on screen — which
 * is the whole reason the manifest exists.
 */
export const VECTOR_PARAMS: ParamSpec[] = [
  {
    key: 'mode',
    label: 'What to do',
    control: 'select',
    options: [
      { value: 'search', label: 'Search — find similar documents' },
      { value: 'upsert', label: 'Add or update documents' },
      { value: 'delete', label: 'Remove documents' },
    ],
  },
  {
    key: 'collection',
    label: 'Collection',
    control: 'text',
    required: true,
    placeholder: 'support-tickets',
    help: 'A namespace inside this workspace. Letters, numbers, hyphens and underscores.',
  },

  // ── search ────────────────────────────────────────────────────────────────
  {
    key: 'query',
    label: 'Find documents like',
    control: 'textarea',
    required: true,
    placeholder: '{{trigger.input.question}}',
    showWhen: { mode: ['search'] },
  },
  {
    key: 'limit',
    label: 'How many to return',
    control: 'number',
    placeholder: '5',
    // Mirrors the executor's own clamp — a control that accepts a value the
    // executor rewrites runs a number the builder never showed.
    min: 1,
    max: 100,
    showWhen: { mode: ['search'] },
  },
  {
    key: 'minScore',
    label: 'Minimum similarity',
    control: 'number',
    placeholder: 'Leave blank to return the closest regardless',
    min: -1,
    max: 1,
    help: '1 is identical, 0 is unrelated. Anything less similar is dropped.',
    showWhen: { mode: ['search'] },
  },

  // ── upsert / delete ───────────────────────────────────────────────────────
  {
    key: 'documents',
    label: 'Documents',
    control: 'textarea',
    required: true,
    placeholder: '{{step.fetch.output}}',
    help: 'A list of items. Each needs a stable id, and for adding, the text to embed.',
    showWhen: { mode: ['upsert', 'delete'] },
  },
  {
    key: 'idField',
    label: 'Which field is the id',
    control: 'text',
    placeholder: 'id',
    help: 'Re-adding the same id updates that document instead of duplicating it.',
    showWhen: { mode: ['upsert', 'delete'] },
  },
  {
    key: 'contentField',
    label: 'Which field holds the text',
    control: 'text',
    placeholder: 'content',
    showWhen: { mode: ['upsert'] },
  },
]
