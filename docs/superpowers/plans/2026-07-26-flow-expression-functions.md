# Flow Expression Function Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the flow template sublanguage from 14 to 36 whitelisted pure functions (dates, arrays, strings, numbers) so users can shape data inline without dropping into a Code node.

**Architecture:** Today all 14 functions live in a `switch` inside `expressionValue`
(`src/features/flows/context.ts:193-209`). Task 1 extracts them, behavior-unchanged, into
a dedicated registry module keyed by name; `expressionValue` keeps literal parsing and
`splitArgs` and dispatches through the registry. Tasks 2–4 add new entries to that
registry. Task 5 renders the registry as a reference list in the NDV.

**Tech Stack:** TypeScript, `node:test` + `node:assert/strict`, React 19 / Next.js App
Router, Tailwind. **No new dependencies** — dates use native `Date`, formatting uses `Intl`.

## Global Constraints

- **No new dependencies.** Native `Date`, `Intl`, `Array`, `String` only.
- **No arbitrary code execution.** The sublanguage keeps its no-eval design: a fixed
  name→function whitelist. Never `eval`, `new Function`, or dynamic property access on
  globals.
- **Every function is total.** Bad, missing, or wrong-typed input returns a safe empty
  value — never throws. Text-returning functions return `''`; number-returning functions
  return `null`; list-returning functions return `[]`. This mirrors how `matches` already
  survives a bad RegExp and how `divide` already returns `null` on divide-by-zero.
- **Unknown function names return `undefined`**, which `resolveTemplate` renders as `''`.
  This is load-bearing security behavior — preserve it exactly.
- **Existing behavior is frozen.** All 14 current functions keep byte-identical semantics,
  including `divide`-by-zero → `null`, `if` with a missing third argument → `undefined`,
  and `length` on an object → key count.
- Code style: no semicolons, single quotes, 2-space indent, arrow functions.
- Run a single test file with:
  `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <path>`
- Run the whole suite with: `npm test`

---

### Task 1: Extract the function registry (behavior-preserving refactor)

This task adds **no** new functions. It moves the existing 14 out of the `switch` and
into a registry so later tasks add entries to a data structure rather than growing a
switch, and so the UI can enumerate them. `context.ts` is already ~330 lines handling
path reading, templating, and conditions; the function table is a separable
responsibility.

**Files:**
- Create: `src/lib/flows/expression-functions.ts`
- Create: `src/lib/flows/__tests__/expression-functions.test.ts`
- Modify: `src/features/flows/context.ts:145-210` (replace the `switch` with registry dispatch)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type ExpressionFunctionSpec = { name: string, signature: string, description: string, group: ExpressionFunctionGroup, apply: (args: unknown[]) => unknown }`
  - `type ExpressionFunctionGroup = 'text' | 'number' | 'logic' | 'date' | 'list'`
  - `const EXPRESSION_FUNCTIONS: Record<string, ExpressionFunctionSpec>`
  - `function text(value: unknown): string`
  - `function number(value: unknown): number`

- [ ] **Step 1: Write the failing test**

Create `src/lib/flows/__tests__/expression-functions.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EXPRESSION_FUNCTIONS, text, number } from '../expression-functions'

const call = (name: string, ...args: unknown[]) => EXPRESSION_FUNCTIONS[name].apply(args)

test('text and number coerce the way the switch did', () => {
  assert.equal(text(null), '')
  assert.equal(text(undefined), '')
  assert.equal(text({ a: 1 }), '{"a":1}')
  assert.equal(text(5), '5')
  assert.equal(number(undefined), 0)
  assert.equal(number('7'), 7)
})

test('the original 14 functions keep their exact semantics', () => {
  assert.equal(call('coalesce', '', null, 'fallback'), 'fallback')
  assert.equal(call('coalesce'), '')
  assert.equal(call('concat', 'a', 1, null), 'a1')
  assert.equal(call('upper', 'acme'), 'ACME')
  assert.equal(call('lower', 'ACME'), 'acme')
  assert.equal(call('trim', '  x  '), 'x')
  assert.equal(call('length', 'abc'), 3)
  assert.equal(call('length', [1, 2]), 2)
  assert.equal(call('length', { a: 1, b: 2 }), 2)
  assert.equal(call('length', 5), 0)
  assert.equal(call('add', 1, 2, 3), 6)
  assert.equal(call('subtract', 5, 2), 3)
  assert.equal(call('multiply', 2, 3), 6)
  assert.equal(call('divide', 6, 3), 2)
  assert.equal(call('divide', 6, 0), null)
  assert.equal(call('if', true, 'yes', 'no'), 'yes')
  assert.equal(call('if', false, 'yes'), undefined)
  assert.deepEqual(call('json', '{"a":1}'), { a: 1 })
  assert.equal(call('json', 'nope'), null)
  assert.equal(call('stringify', { a: 1 }), '{"a":1}')
  assert.match(call('now') as string, /^\d{4}-\d{2}-\d{2}T/)
})

test('every function is total: no argument shape throws', () => {
  const garbage: unknown[][] = [[], [undefined], [null], [{}], [[]], ['x', 'y', 'z'], [NaN, NaN]]
  for (const spec of Object.values(EXPRESSION_FUNCTIONS)) {
    for (const args of garbage) {
      assert.doesNotThrow(() => spec.apply(args), `${spec.name} threw on ${JSON.stringify(args)}`)
    }
  }
})

test('every function carries reference metadata', () => {
  for (const [key, spec] of Object.entries(EXPRESSION_FUNCTIONS)) {
    assert.equal(key, spec.name, 'registry key must match spec.name')
    assert.ok(spec.signature.startsWith(`${spec.name}(`), `${spec.name} signature malformed`)
    assert.ok(spec.description.length > 0, `${spec.name} missing description`)
  }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/expression-functions.test.ts`

Expected: FAIL — cannot find module `../expression-functions`.

- [ ] **Step 3: Write the registry module**

Create `src/lib/flows/expression-functions.ts`:

```ts
/**
 * The whitelist behind the `{{= fn(...) }}` flow sublanguage. Every entry is a
 * pure function of already-evaluated arguments: no context access, no property
 * assignment, no imports, no arbitrary JavaScript. Callers dispatch by name and
 * treat a missing name as `undefined`.
 *
 * Every function is TOTAL — bad or missing input returns a safe empty value
 * ('' for text, null for numbers, [] for lists) rather than throwing, because a
 * template that throws would fail an entire flow run over a typo.
 */

export type ExpressionFunctionGroup = 'text' | 'number' | 'logic' | 'date' | 'list'

export type ExpressionFunctionSpec = {
  name: string
  signature: string
  description: string
  group: ExpressionFunctionGroup
  apply: (args: unknown[]) => unknown
}

/** Render any value as text. Objects become JSON; null/undefined become ''. */
export function text(value: unknown): string {
  return value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
}

/** Coerce to a number, treating null/undefined as 0. */
export function number(value: unknown): number {
  return Number(value ?? 0)
}

const spec = (
  name: string,
  group: ExpressionFunctionGroup,
  signature: string,
  description: string,
  apply: (args: unknown[]) => unknown,
): [string, ExpressionFunctionSpec] => [name, { name, group, signature, description, apply }]

export const EXPRESSION_FUNCTIONS: Record<string, ExpressionFunctionSpec> = Object.fromEntries([
  spec('coalesce', 'logic', 'coalesce(a, b, ...)', 'First value that is not empty, null, or undefined.',
    (args) => args.find((item) => item !== undefined && item !== null && item !== '') ?? ''),
  spec('concat', 'text', 'concat(a, b, ...)', 'Join all arguments into one string.',
    (args) => args.map(text).join('')),
  spec('upper', 'text', 'upper(value)', 'Uppercase.',
    (args) => text(args[0]).toUpperCase()),
  spec('lower', 'text', 'lower(value)', 'Lowercase.',
    (args) => text(args[0]).toLowerCase()),
  spec('trim', 'text', 'trim(value)', 'Remove leading and trailing whitespace.',
    (args) => text(args[0]).trim()),
  spec('length', 'number', 'length(value)', 'Length of a string or list, or key count of an object.',
    (args) => typeof args[0] === 'string' || Array.isArray(args[0])
      ? (args[0] as string | unknown[]).length
      : args[0] && typeof args[0] === 'object' ? Object.keys(args[0]).length : 0),
  spec('add', 'number', 'add(a, b, ...)', 'Sum of all arguments.',
    (args) => args.reduce((sum: number, item) => sum + number(item), 0)),
  spec('subtract', 'number', 'subtract(a, b)', 'a minus b.',
    (args) => number(args[0]) - number(args[1])),
  spec('multiply', 'number', 'multiply(a, b, ...)', 'Product of all arguments.',
    (args) => args.reduce((product: number, item) => product * number(item), 1)),
  spec('divide', 'number', 'divide(a, b)', 'a divided by b; empty when b is zero.',
    (args) => number(args[1]) === 0 ? null : number(args[0]) / number(args[1])),
  spec('if', 'logic', 'if(condition, then, else)', 'Pick one of two values.',
    (args) => args[0] ? args[1] : args[2]),
  spec('json', 'logic', 'json(text)', 'Parse JSON text; empty when it does not parse.',
    (args) => { try { return JSON.parse(text(args[0])) } catch { return null } }),
  spec('stringify', 'logic', 'stringify(value)', 'Render a value as JSON text.',
    (args) => JSON.stringify(args[0])),
  spec('now', 'date', 'now()', 'Current time as an ISO timestamp.',
    () => new Date().toISOString()),
])
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/expression-functions.test.ts`

Expected: PASS, 4 tests.

- [ ] **Step 5: Dispatch through the registry from `context.ts`**

In `src/features/flows/context.ts`, add the import beside the existing imports at the top
of the file:

```ts
import { EXPRESSION_FUNCTIONS } from '@/lib/flows/expression-functions'
```

Then replace the body of `expressionValue` from the `const args =` line through the
closing brace of the `switch` (currently lines 190-209) with:

```ts
  const args = splitArgs(call[2]).map((arg) => expressionValue(arg, ctx))
  const fn = EXPRESSION_FUNCTIONS[call[1]]
  // An unknown name resolves to undefined, which renders as '' — this is what
  // keeps `{{= someUnknownThing() }}` inert rather than an error.
  return fn ? fn.apply(args) : undefined
}
```

The local `text` and `number` helper consts inside `expressionValue` are now unused —
delete them. Everything above `const call = ...` (literal, boolean, null, number, and
JSON parsing) stays exactly as it is.

- [ ] **Step 6: Verify no behavior changed**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/flows/__tests__/context.test.ts`

Expected: PASS — in particular the existing assertions for `upper`, `add`, `coalesce`, and
the security case `{{= process.exit() }}` → `''`.

Then run the full suite: `npm test`

Expected: PASS. No test should change; this task is behavior-preserving.

- [ ] **Step 7: Commit**

```bash
git add src/lib/flows/expression-functions.ts src/lib/flows/__tests__/expression-functions.test.ts src/features/flows/context.ts
git commit -m "refactor(flows): extract expression functions into a registry"
```

---

### Task 2: Date functions

**Files:**
- Modify: `src/lib/flows/expression-functions.ts` (add helpers + 4 entries)
- Modify: `src/lib/flows/__tests__/expression-functions.test.ts` (add a test)

**Interfaces:**
- Consumes: `EXPRESSION_FUNCTIONS`, `text` from Task 1.
- Produces: registry entries `formatDate`, `addTime`, `diffDays`, `startOfDay`. All
  operate in **UTC** so a flow produces the same value on any worker.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/flows/__tests__/expression-functions.test.ts`:

```ts
test('date functions format, shift, diff, and truncate in UTC', () => {
  assert.equal(call('formatDate', '2026-07-26T15:04:05Z'), '2026-07-26')
  assert.equal(call('formatDate', '2026-07-26T15:04:05Z', 'DD/MM/YYYY'), '26/07/2026')
  assert.equal(call('formatDate', '2026-07-26T15:04:05Z', 'HH:mm:ss'), '15:04:05')
  assert.equal(call('addTime', '2026-07-26T00:00:00Z', 3, 'days'), '2026-07-29T00:00:00.000Z')
  assert.equal(call('addTime', '2026-07-26T00:00:00Z', -1, 'hours'), '2026-07-25T23:00:00.000Z')
  assert.equal(call('addTime', '2026-01-31T00:00:00Z', 1, 'months'), '2026-03-03T00:00:00.000Z')
  assert.equal(call('diffDays', '2026-07-29T00:00:00Z', '2026-07-26T00:00:00Z'), 3)
  assert.equal(call('diffDays', '2026-07-26T00:00:00Z', '2026-07-29T00:00:00Z'), -3)
  assert.equal(call('startOfDay', '2026-07-26T15:04:05Z'), '2026-07-26T00:00:00.000Z')
})

test('date functions return empty on unparseable input', () => {
  assert.equal(call('formatDate', 'not a date'), '')
  assert.equal(call('formatDate'), '')
  assert.equal(call('addTime', 'nope', 3, 'days'), '')
  assert.equal(call('addTime', '2026-07-26T00:00:00Z', 3, 'fortnights'), '')
  assert.equal(call('diffDays', 'nope', '2026-07-26T00:00:00Z'), null)
  assert.equal(call('startOfDay', 'nope'), '')
})
```

Note the `2026-01-31 + 1 month` case: JavaScript's `setUTCMonth` overflows February into
March. That is the documented, tested behavior — not a bug to fix.

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/expression-functions.test.ts`

Expected: FAIL — `Cannot read properties of undefined (reading 'apply')` for `formatDate`.

- [ ] **Step 3: Add the date helpers and entries**

In `src/lib/flows/expression-functions.ts`, add above the `EXPRESSION_FUNCTIONS` declaration:

```ts
/** Parse anything date-like into a valid Date, or null. Never throws. */
function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  const raw = typeof value === 'number' ? value : text(value).trim()
  if (raw === '') return null
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

const pad = (value: number) => String(value).padStart(2, '0')

const MS_PER_UNIT: Record<string, number> = {
  second: 1000, seconds: 1000,
  minute: 60_000, minutes: 60_000,
  hour: 3_600_000, hours: 3_600_000,
  day: 86_400_000, days: 86_400_000,
  week: 604_800_000, weeks: 604_800_000,
}
```

Then add these four entries inside the `Object.fromEntries([...])` array, after the `now` entry:

```ts
  spec('formatDate', 'date', 'formatDate(value, pattern)',
    'Format a date using YYYY, MM, DD, HH, mm, ss. Defaults to YYYY-MM-DD. UTC.',
    (args) => {
      const date = toDate(args[0])
      if (!date) return ''
      const pattern = args[1] === undefined ? 'YYYY-MM-DD' : text(args[1])
      return pattern
        .replace(/YYYY/g, String(date.getUTCFullYear()))
        .replace(/MM/g, pad(date.getUTCMonth() + 1))
        .replace(/DD/g, pad(date.getUTCDate()))
        .replace(/HH/g, pad(date.getUTCHours()))
        .replace(/mm/g, pad(date.getUTCMinutes()))
        .replace(/ss/g, pad(date.getUTCSeconds()))
    }),
  spec('addTime', 'date', 'addTime(value, amount, unit)',
    'Shift a date by seconds, minutes, hours, days, weeks, months, or years. Negative amounts subtract.',
    (args) => {
      const date = toDate(args[0])
      const amount = Number(args[1])
      if (!date || !Number.isFinite(amount)) return ''
      const unit = text(args[2] === undefined ? 'days' : args[2]).toLowerCase()
      if (unit === 'month' || unit === 'months') {
        const shifted = new Date(date.getTime())
        shifted.setUTCMonth(shifted.getUTCMonth() + amount)
        return shifted.toISOString()
      }
      if (unit === 'year' || unit === 'years') {
        const shifted = new Date(date.getTime())
        shifted.setUTCFullYear(shifted.getUTCFullYear() + amount)
        return shifted.toISOString()
      }
      const ms = MS_PER_UNIT[unit]
      return ms ? new Date(date.getTime() + amount * ms).toISOString() : ''
    }),
  spec('diffDays', 'date', 'diffDays(a, b)',
    'Whole days from b to a. Negative when a is earlier. Empty if either is unparseable.',
    (args) => {
      const a = toDate(args[0])
      const b = toDate(args[1])
      if (!a || !b) return null
      return Math.round((a.getTime() - b.getTime()) / 86_400_000)
    }),
  spec('startOfDay', 'date', 'startOfDay(value)', 'Midnight UTC on the same date.',
    (args) => {
      const date = toDate(args[0])
      if (!date) return ''
      return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString()
    }),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/expression-functions.test.ts`

Expected: PASS, 6 tests. The totality test from Task 1 now covers the four new functions
automatically.

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/expression-functions.ts src/lib/flows/__tests__/expression-functions.test.ts
git commit -m "feat(flows): add date expression functions"
```

---

### Task 3: List functions

**Files:**
- Modify: `src/lib/flows/expression-functions.ts` (add a `list` helper + 8 entries)
- Modify: `src/lib/flows/__tests__/expression-functions.test.ts` (add a test)

**Interfaces:**
- Consumes: `EXPRESSION_FUNCTIONS`, `text`, `number` from Task 1.
- Produces: registry entries `first`, `last`, `count`, `joinList`, `pluck`, `unique`,
  `sum`, `sortBy`, plus an internal `list(value)` coercion shared by all of them.

`list` coercion rules: an array passes through; a string that parses as a JSON array
becomes that array (step outputs are often JSON text); `null`/`undefined`/`''` become
`[]`; anything else becomes a one-item list. The name is `joinList`, not `join`, to avoid
colliding with the `data` node's existing `join` operation vocabulary.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/flows/__tests__/expression-functions.test.ts`:

```ts
test('list functions read, join, and reshape lists', () => {
  assert.equal(call('first', [1, 2, 3]), 1)
  assert.equal(call('last', [1, 2, 3]), 3)
  assert.equal(call('count', [1, 2, 3]), 3)
  assert.equal(call('joinList', ['a', 'b'], ' & '), 'a & b')
  assert.equal(call('joinList', ['a', 'b']), 'a, b')
  assert.deepEqual(call('pluck', [{ id: 1 }, { id: 2 }], 'id'), [1, 2])
  assert.deepEqual(call('unique', [1, 2, 2, 3, 1]), [1, 2, 3])
  assert.deepEqual(call('unique', [{ a: 1 }, { a: 1 }]), [{ a: 1 }])
  assert.equal(call('sum', [1, 2, 3]), 6)
  assert.equal(call('sum', [1, 'nope', 3]), 4)
  assert.deepEqual(call('sortBy', [3, 1, 2]), [1, 2, 3])
  assert.deepEqual(call('sortBy', [{ n: 3 }, { n: 1 }], 'n'), [{ n: 1 }, { n: 3 }])
  assert.deepEqual(call('sortBy', ['pear', 'apple']), ['apple', 'pear'])
})

test('list functions coerce JSON-text lists and non-lists', () => {
  assert.equal(call('first', '["a","b"]'), 'a')
  assert.equal(call('count', '["a","b"]'), 2)
  assert.equal(call('count', 'plain'), 1)
  assert.equal(call('count', null), 0)
  assert.equal(call('count'), 0)
  assert.equal(call('first', []), '')
  assert.equal(call('last', []), '')
  assert.deepEqual(call('pluck', [1, 2], 'id'), ['', ''])
  assert.equal(call('sum', 'nope'), 0)
})

test('sortBy does not mutate its input', () => {
  const input = [3, 1, 2]
  call('sortBy', input)
  assert.deepEqual(input, [3, 1, 2])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/expression-functions.test.ts`

Expected: FAIL — `first` is not in the registry.

- [ ] **Step 3: Add the list helper and entries**

In `src/lib/flows/expression-functions.ts`, add beside the other helpers:

```ts
/**
 * Coerce a value into a list. Step outputs are frequently JSON text, so a string
 * that parses to an array is treated as that array; a lone value becomes a
 * one-item list so `count(x)` is 1 rather than a confusing 0.
 */
function list(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (value === null || value === undefined || value === '') return []
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value.trim())
      if (Array.isArray(parsed)) return parsed
    } catch { /* not JSON — fall through to the single-item case */ }
  }
  return [value]
}

/** Stable comparison key so `unique` can dedupe objects by value. */
const identity = (item: unknown) => typeof item === 'object' && item !== null ? JSON.stringify(item) : String(item)
```

Then add these eight entries to the `Object.fromEntries([...])` array:

```ts
  spec('first', 'list', 'first(list)', 'First item, or empty.',
    (args) => list(args[0])[0] ?? ''),
  spec('last', 'list', 'last(list)', 'Last item, or empty.',
    (args) => { const items = list(args[0]); return items.length ? items[items.length - 1] ?? '' : '' }),
  spec('count', 'list', 'count(list)', 'Number of items.',
    (args) => list(args[0]).length),
  spec('joinList', 'list', 'joinList(list, separator)', 'Join items into text. Separator defaults to ", ".',
    (args) => list(args[0]).map(text).join(args[1] === undefined ? ', ' : text(args[1]))),
  spec('pluck', 'list', 'pluck(list, key)', 'Collect one field from every item.',
    (args) => list(args[0]).map((item) =>
      item && typeof item === 'object' ? (item as Record<string, unknown>)[text(args[1])] ?? '' : '')),
  spec('unique', 'list', 'unique(list)', 'Remove duplicate items, keeping first appearance.',
    (args) => {
      const seen = new Set<string>()
      const out: unknown[] = []
      for (const item of list(args[0])) {
        const key = identity(item)
        if (!seen.has(key)) { seen.add(key); out.push(item) }
      }
      return out
    }),
  spec('sum', 'list', 'sum(list)', 'Add every numeric item; non-numbers count as zero.',
    (args) => list(args[0]).reduce((total: number, item) => {
      const value = Number(item)
      return total + (Number.isFinite(value) ? value : 0)
    }, 0)),
  spec('sortBy', 'list', 'sortBy(list, key)',
    'Sort a copy of the list. Numeric when possible, otherwise alphabetical. Omit key to sort the items themselves.',
    (args) => {
      const key = args[1] === undefined ? '' : text(args[1])
      const valueOf = (item: unknown) =>
        key && item && typeof item === 'object' ? (item as Record<string, unknown>)[key] : item
      return [...list(args[0])].sort((a, b) => {
        const left = valueOf(a)
        const right = valueOf(b)
        const leftNumber = Number(left)
        const rightNumber = Number(right)
        const bothNumeric = Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
          && text(left).trim() !== '' && text(right).trim() !== ''
        return bothNumeric ? leftNumber - rightNumber : text(left).localeCompare(text(right))
      })
    }),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/expression-functions.test.ts`

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/expression-functions.ts src/lib/flows/__tests__/expression-functions.test.ts
git commit -m "feat(flows): add list expression functions"
```

---

### Task 4: String and number functions

**Files:**
- Modify: `src/lib/flows/expression-functions.ts` (add 10 entries)
- Modify: `src/lib/flows/__tests__/expression-functions.test.ts` (add a test)
- Modify: `src/features/flows/__tests__/context.test.ts` (end-to-end through `{{= }}`)

**Interfaces:**
- Consumes: `EXPRESSION_FUNCTIONS`, `text` from Task 1.
- Produces: registry entries `split`, `replace`, `slice`, `padStart`, `capitalize`,
  `round`, `floor`, `ceil`, `abs`, `formatNumber`.

Two deliberate decisions, both tested below:
- `split` **trims each part**. Flow data is overwhelmingly `"a, b, c"`-shaped, there is no
  way to map `trim` over a list in this sublanguage, and `loopItems` in `interpret.ts`
  already sets this precedent for comma-splitting.
- `replace` is **literal, not regex** — no user-supplied pattern reaches a RegExp
  constructor, so there is no catastrophic-backtracking surface.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/flows/__tests__/expression-functions.test.ts`:

```ts
test('string functions split, replace, slice, pad, and capitalize', () => {
  assert.deepEqual(call('split', 'a, b, c'), ['a', 'b', 'c'])
  assert.deepEqual(call('split', 'a|b', '|'), ['a', 'b'])
  assert.deepEqual(call('split', ''), [])
  assert.equal(call('replace', 'a-b-c', '-', '+'), 'a+b+c')
  assert.equal(call('replace', 'abc', '', 'x'), 'abc')
  assert.equal(call('slice', 'abcdef', 1, 3), 'bc')
  assert.equal(call('slice', 'abcdef', 3), 'def')
  assert.equal(call('padStart', '7', 3, '0'), '007')
  assert.equal(call('padStart', '7', 3), '  7')
  assert.equal(call('capitalize', 'acme corp'), 'Acme corp')
  assert.equal(call('capitalize', ''), '')
})

test('number functions round and format, and stay empty on non-numbers', () => {
  assert.equal(call('round', 3.14159, 2), 3.14)
  assert.equal(call('round', 3.6), 4)
  assert.equal(call('floor', 3.9), 3)
  assert.equal(call('ceil', 3.1), 4)
  assert.equal(call('abs', -5), 5)
  assert.equal(call('formatNumber', 1234567.891), '1,234,567.891')
  assert.equal(call('round', 'nope'), null)
  assert.equal(call('floor', 'nope'), null)
  assert.equal(call('ceil', 'nope'), null)
  assert.equal(call('abs', 'nope'), null)
  assert.equal(call('formatNumber', 'nope'), '')
})

test('padStart cannot be used to allocate an enormous string', () => {
  assert.equal((call('padStart', 'x', 1e9, 'y') as string).length, 1000)
})
```

Also append to `src/features/flows/__tests__/context.test.ts`, which proves the new
functions resolve through the real `{{= }}` pipeline rather than only via direct calls:

```ts
test('new expression functions resolve through templates', () => {
  const listCtx: FlowContext = {
    trigger: { input: 'Acme, Globex' },
    step: { rows: { output: [{ amount: 10 }, { amount: 32 }] } },
  }
  assert.equal(resolveTemplateValue('{{= sum(pluck(step.rows.output, "amount")) }}', listCtx), 42)
  assert.equal(resolveTemplate('{{= joinList(split(trigger.input), " + ") }}', listCtx), 'Acme + Globex')
  assert.equal(resolveTemplate('{{= formatDate("2026-07-26T00:00:00Z", "DD/MM/YYYY") }}', listCtx), '26/07/2026')
  assert.equal(resolveTemplate('{{= round(divide(1, 3), 2) }}', listCtx), '0.33')
})
```

- [ ] **Step 2: Run both tests to verify they fail**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/expression-functions.test.ts src/features/flows/__tests__/context.test.ts`

Expected: FAIL — `split` is not in the registry.

- [ ] **Step 3: Add the string and number entries**

Add these ten entries to the `Object.fromEntries([...])` array in
`src/lib/flows/expression-functions.ts`:

```ts
  spec('split', 'text', 'split(value, separator)',
    'Split text into a list, trimming each part. Separator defaults to ",".',
    (args) => {
      const source = text(args[0])
      if (source === '') return []
      const separator = args[1] === undefined ? ',' : text(args[1])
      if (separator === '') return [source]
      return source.split(separator).map((part) => part.trim())
    }),
  spec('replace', 'text', 'replace(value, find, replacement)',
    'Replace every literal occurrence. Not a regular expression.',
    (args) => {
      const find = text(args[1])
      return find === '' ? text(args[0]) : text(args[0]).split(find).join(text(args[2]))
    }),
  spec('slice', 'text', 'slice(value, start, end)', 'Substring from start up to end. Negative counts from the end.',
    (args) => {
      const start = Number(args[1])
      const end = args[2] === undefined ? undefined : Number(args[2])
      return text(args[0]).slice(
        Number.isFinite(start) ? start : 0,
        end !== undefined && Number.isFinite(end) ? end : undefined,
      )
    }),
  spec('padStart', 'text', 'padStart(value, length, padding)',
    'Pad the start of text up to length. Padding defaults to a space. Capped at 1000 characters.',
    (args) => {
      const source = text(args[0])
      const length = Number(args[1])
      if (!Number.isFinite(length) || length <= 0) return source
      const padding = args[2] === undefined ? ' ' : text(args[2])
      // Capped so a template typo cannot allocate a huge string mid-run.
      return padding === '' ? source : source.padStart(Math.min(length, 1000), padding)
    }),
  spec('capitalize', 'text', 'capitalize(value)', 'Uppercase the first character.',
    (args) => { const source = text(args[0]); return source ? source[0].toUpperCase() + source.slice(1) : '' }),
  spec('round', 'number', 'round(value, places)', 'Round to the given decimal places. Defaults to whole numbers.',
    (args) => {
      const value = Number(args[0])
      const places = args[1] === undefined ? 0 : Number(args[1])
      if (!Number.isFinite(value) || !Number.isFinite(places)) return null
      const factor = 10 ** Math.min(Math.max(Math.trunc(places), 0), 15)
      return Math.round(value * factor) / factor
    }),
  spec('floor', 'number', 'floor(value)', 'Round down.',
    (args) => { const value = Number(args[0]); return Number.isFinite(value) ? Math.floor(value) : null }),
  spec('ceil', 'number', 'ceil(value)', 'Round up.',
    (args) => { const value = Number(args[0]); return Number.isFinite(value) ? Math.ceil(value) : null }),
  spec('abs', 'number', 'abs(value)', 'Absolute value.',
    (args) => { const value = Number(args[0]); return Number.isFinite(value) ? Math.abs(value) : null }),
  spec('formatNumber', 'number', 'formatNumber(value, locale)',
    'Format with thousands separators. Locale defaults to en-US.',
    (args) => {
      const value = Number(args[0])
      if (!Number.isFinite(value)) return ''
      try {
        return new Intl.NumberFormat(args[1] === undefined ? 'en-US' : text(args[1])).format(value)
      } catch {
        return String(value)
      }
    }),
```

- [ ] **Step 4: Run both tests to verify they pass**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/expression-functions.test.ts src/features/flows/__tests__/context.test.ts`

Expected: PASS.

Then the full suite: `npm test` — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/expression-functions.ts src/lib/flows/__tests__/expression-functions.test.ts src/features/flows/__tests__/context.test.ts
git commit -m "feat(flows): add string and number expression functions"
```

---

### Task 5: Function reference in the node detail view

**Note on scope.** The design spec said "the builder's function hint list is updated."
No such list exists — `coalesce` appears nowhere in the UI layer, so there is nothing to
update. Rather than silently dropping the requirement or building a full autocomplete
engine, this task renders the registry as a searchable reference in the Parameters tab.
Autocomplete inside the token editor is deliberately **not** in scope.

**Files:**
- Create: `src/components/flows/ndv/function-reference.tsx`
- Modify: `src/components/flows/ndv/params-pane.tsx:37-43`

**Interfaces:**
- Consumes: `EXPRESSION_FUNCTIONS`, `ExpressionFunctionGroup` from Task 1.
- Produces: `<FunctionReference />` — a self-contained collapsible, no props.

- [ ] **Step 1: Create the component**

Create `src/components/flows/ndv/function-reference.tsx`:

```tsx
'use client'

import { useMemo, useState } from 'react'
import { EXPRESSION_FUNCTIONS, type ExpressionFunctionGroup } from '@/lib/flows/expression-functions'

const GROUP_LABEL: Record<ExpressionFunctionGroup, string> = {
  text: 'Text',
  number: 'Numbers',
  logic: 'Logic',
  date: 'Dates',
  list: 'Lists',
}

const GROUP_ORDER: ExpressionFunctionGroup[] = ['text', 'number', 'date', 'list', 'logic']

/**
 * Reference for the `{{= ... }}` sublanguage, rendered straight from the registry
 * so a function can never ship without appearing here.
 */
export function FunctionReference() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    const term = query.trim().toLowerCase()
    const specs = Object.values(EXPRESSION_FUNCTIONS).filter((spec) =>
      !term || spec.name.toLowerCase().includes(term) || spec.description.toLowerCase().includes(term))
    return GROUP_ORDER
      .map((group) => ({ group, specs: specs.filter((spec) => spec.group === group) }))
      .filter((entry) => entry.specs.length > 0)
  }, [query])

  return (
    <div className="border-t border-border px-4 py-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="text-xs font-semibold text-muted-foreground hover:text-foreground"
      >
        {open ? 'Hide' : 'Show'} expression functions
      </button>
      {open && (
        <div className="mt-3 grid gap-3">
          <p className="text-xs text-muted-foreground">
            Use these inside <code className="rounded bg-muted px-1">{'{{= }}'}</code>, for example{' '}
            <code className="rounded bg-muted px-1">{'{{= upper(trigger.input) }}'}</code>.
          </p>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search functions"
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
          />
          {groups.length === 0 && <p className="text-xs text-muted-foreground">No matching functions.</p>}
          {groups.map(({ group, specs }) => (
            <div key={group} className="grid gap-1">
              <p className="text-xs font-semibold text-foreground">{GROUP_LABEL[group]}</p>
              {specs.map((spec) => (
                <div key={spec.name} className="grid gap-0.5">
                  <code className="text-xs text-foreground">{spec.signature}</code>
                  <span className="text-xs text-muted-foreground">{spec.description}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Mount it in the Parameters tab**

In `src/components/flows/ndv/params-pane.tsx`, add the import beside the others:

```tsx
import { FunctionReference } from './function-reference'
```

Then replace the `parameters` branch (currently lines 37-43) with:

```tsx
      {tab === 'parameters' ? (
        <>
          <MissingFields node={props.node} />
          <div className="p-4">
            <Body {...props} />
          </div>
          {props.node.type !== 'trigger' && <FunctionReference />}
        </>
      ) : (
```

The trigger node is excluded because its body configures schedules and webhooks rather
than token-bearing fields.

- [ ] **Step 3: Verify it compiles and the suite still passes**

Run: `npx tsc --noEmit -p tsconfig.json`

Expected: no errors introduced by these two files.

Run: `npm test`

Expected: PASS. (There is no React component-test harness in this repo — all tests are
`.test.ts` logic tests — so this component is covered by type-checking and the registry
metadata test from Task 1, which guarantees every entry has a signature and description
to render.)

- [ ] **Step 4: Commit**

```bash
git add src/components/flows/ndv/function-reference.tsx src/components/flows/ndv/params-pane.tsx
git commit -m "feat(flows): show expression function reference in the node detail view"
```

---

## Done criteria

- 36 functions in `EXPRESSION_FUNCTIONS` (14 preserved, 22 added).
- `npm test` passes, including the pre-existing `{{= process.exit() }}` → `''` security
  assertion.
- The totality test proves no function throws on any of seven garbage argument shapes.
- Every function appears in the NDV reference, enforced by the metadata test.
- No new dependency in `package.json`.
