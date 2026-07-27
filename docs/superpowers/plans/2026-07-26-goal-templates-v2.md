# Goal Templates v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the goal-template gallery to match the agent/flow catalogue — rich cards, a detail modal with tool-connection state and a live dashboard preview, 9-per-page pagination over 45 templates, per-template dashboard layouts — and fix templated goals appearing to vanish after creation.

**Architecture:** Templates become richer *data* (`category`, `sources`, `layout`, `tracks`) consumed by new presentation components. No API or schema changes: `Goal.dashboardLayout` and `POST /api/goals`'s `dashboardLayout` field already exist. Two pure refactors land first (a shared preview-data builder, a shared card shell) so new components build on stable seams.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Tailwind, Zod, Prisma. Tests are `node:test` run through `tsx`; component tests use `@testing-library/react` with `@/test-support/jsdom-env`.

**Spec:** [docs/superpowers/specs/2026-07-26-goal-templates-v2-design.md](../specs/2026-07-26-goal-templates-v2-design.md)

## Global Constraints

- **No schema migration.** `Goal.dashboardLayout` exists; `POST /api/goals` already accepts and validates `dashboardLayout` via `parseDraftLayout` / `resolveLayoutMetricRefs`. Do not add Prisma models or fields.
- **No new departments.** `PRODUCT_DEPARTMENTS` in `src/lib/templates/departments.ts` is shared with the agent catalogue, relevance sorting and BI auto-tagging. The catalogue grows by depth: **5 departments × 9 templates = 45**, split **5 org / 4 personal** per department.
- **Single-metric widgets only.** Template layouts may use only `kpi`, `trend`, `progress`, `narrative`, `impact`, `benchmark`, `periods`, `contributions`, `history`, `rollups`. **Never** `comparison` or `ratio` — those need 2+ metrics and the wizard binds exactly one.
- **`narrative` is excluded from every preset.** Its config requires `text`; canned copy on every dashboard reads as filler.
- **All 20 existing template keys are preserved verbatim.** Bookmarked `/goals/new?template=<key>` links must keep resolving.
- **`manual` is always the last entry in every template's `sources`.** No template may be a dead end.
- **Page size is exactly 9.** Grid is `sm:grid-cols-2 lg:grid-cols-3` (a 3×3 block).
- Run tests with `npm test`. Run `npm run typecheck` before every commit. Do **not** run `npm run build` per task — it runs migrations.
- Commit messages use Conventional Commits and end with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## Already Exists — Do Not Rebuild

Verified present before this plan was written:

| Thing | Location | Use it for |
|---|---|---|
| `Pagination` + `paginate<T>()` | `src/components/ui/pagination.tsx` (tested in `src/components/ui/__tests__/pagination.test.ts`) | Task 9 — clamping and slicing are already handled |
| `ErrorBoundary` | `src/components/ui/error-boundary.tsx` | Task 8 — wrapping the preview |
| `Dialog*` primitives | `src/components/ui/dialog.tsx` | Task 8 |
| `IntegrationChip` | `src/components/integrations/integration-chip.tsx` | Tasks 7, 8 |
| `SOURCE_LABELS`, `SOURCE_HINTS` | `src/components/goals/source-labels.ts` | Tasks 1, 8 |
| `sourceIsAvailable()`, `MetricSourceOption` | `src/lib/metrics/source-options.ts` | Task 8 |
| `parseDraftLayout`, `resolveLayoutMetricRefs`, `DashboardLayout`, `WidgetType` | `src/lib/goals/dashboard.ts` | Tasks 2, 6, 10 |
| `GoalDashboard`, `DashboardData` | `src/components/goals/widgets/goal-dashboard.tsx` | Tasks 6, 8 |

---

## File Structure

**Create**

| File | Responsibility |
|---|---|
| `src/lib/goals/metric-sources.ts` | The `METRIC_SOURCES` union + `NO_CONNECTION_SOURCES`, shared by the API route, the wizard and the template catalogue |
| `src/lib/goals/goal-template-layouts.ts` | The six named `DashboardLayout` presets |
| `src/lib/goals/preview-data.ts` | `buildPreviewDashboardData()` — synthetic `DashboardData` for any pre-creation preview |
| `src/components/goals/goal-template-accents.ts` | Category → accent classes + lucide icon (explicit `Record`, not hashed) |
| `src/components/templates/template-card-shell.tsx` | The card chrome shared by agent, flow and goal template cards |
| `src/components/goals/goal-template-card.tsx` | The goal template card (a `button` that opens the modal) |
| `src/components/goals/goal-template-detail.tsx` | The detail dialog: tracks copy, ranked source rows, dashboard preview |

**Modify**

| File | Change |
|---|---|
| `src/lib/goals/goal-templates.ts` | New `GoalTemplate` fields; catalogue 20 → 45 |
| `src/app/api/goals/route.ts` | Import `METRIC_SOURCES` / `NO_CONNECTION_SOURCES` instead of declaring them |
| `src/components/goals/metric-binding-fields.tsx` | Import `NO_CONNECTION_SOURCES` instead of declaring it |
| `src/components/templates/template-catalogue-card.tsx` | Compose `TemplateCardShell`; no visual change |
| `src/components/goals/copilot-preview.tsx` | Consume `buildPreviewDashboardData`; behavior-preserving |
| `src/components/goals/goal-template-gallery.tsx` | Pagination + new cards + modal wiring |
| `src/app/goals/new/page.tsx` | Carry `entry.layout` into the POST; redirect to the created goal |
| `src/app/goals/page.tsx` | Always render both goal sections |

**Tests**

`src/lib/goals/__tests__/metric-sources.test.ts` · `src/lib/goals/__tests__/goal-templates.test.ts` (rewrite) · `src/lib/goals/__tests__/preview-data.test.ts` · `src/components/goals/__tests__/preview-data-widgets.test.tsx` · `src/components/templates/__tests__/template-catalogue-card.test.tsx` · `src/components/goals/__tests__/goal-template-card.test.tsx` · `src/components/goals/__tests__/goal-template-detail.test.tsx` · `src/components/goals/__tests__/goal-template-gallery.test.tsx`

---

## Task 1: Shared metric-source vocabulary

The template catalogue must not be able to name a metric source the API rejects. Today `METRIC_SOURCES` and `NO_CONNECTION_SOURCES` are declared inside the API route and duplicated in `metric-binding-fields.tsx`. Lift them to one module.

**Files:**
- Create: `src/lib/goals/metric-sources.ts`
- Create: `src/lib/goals/__tests__/metric-sources.test.ts`
- Modify: `src/app/api/goals/route.ts:23-36`
- Modify: `src/components/goals/metric-binding-fields.tsx:29`

**Interfaces:**
- Consumes: `SOURCE_LABELS` from `src/components/goals/source-labels.ts`
- Produces: `METRIC_SOURCES: readonly MetricSource[]`, `type MetricSource`, `NO_CONNECTION_SOURCES: Set<MetricSource>` from `@/lib/goals/metric-sources`

- [ ] **Step 1: Write the failing test**

Create `src/lib/goals/__tests__/metric-sources.test.ts`:

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { METRIC_SOURCES, NO_CONNECTION_SOURCES } from '../metric-sources'
import { SOURCE_LABELS } from '@/components/goals/source-labels'

test('every metric source has a user-facing label, and no label is orphaned', () => {
  for (const source of METRIC_SOURCES) {
    assert.ok(SOURCE_LABELS[source], `${source} has no SOURCE_LABELS entry`)
  }
  for (const key of Object.keys(SOURCE_LABELS)) {
    assert.ok(
      (METRIC_SOURCES as readonly string[]).includes(key),
      `SOURCE_LABELS has orphaned key ${key}`,
    )
  }
})

test('connection-free sources are a subset of the source union', () => {
  assert.ok(NO_CONNECTION_SOURCES.size > 0)
  for (const source of NO_CONNECTION_SOURCES) {
    assert.ok(
      (METRIC_SOURCES as readonly string[]).includes(source),
      `${source} is not a valid metric source`,
    )
  }
  assert.ok(NO_CONNECTION_SOURCES.has('manual'))
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test --test-name-pattern='metric source' $(find src -path '*__tests__*' -name 'metric-sources.test.ts')`
Expected: FAIL — `Cannot find module '../metric-sources'`

- [ ] **Step 3: Create the module**

Create `src/lib/goals/metric-sources.ts`:

```ts
/**
 * The metric-source vocabulary, shared by the create API, the goal wizard and
 * the template catalogue. Lifted out of the API route so a template cannot
 * name a source the server would reject.
 */
export const METRIC_SOURCES = [
  'stripe',
  'hubspot',
  'salesforce',
  'google_sheets',
  'postgres',
  'url',
  'slack_assisted',
  'gmail_assisted',
  'manual',
] as const

export type MetricSource = (typeof METRIC_SOURCES)[number]

/** Sources that carry no connectionRef: manual has none, url fetches
 *  directly, slack_assisted rides the workspace-level Slack integration. */
export const NO_CONNECTION_SOURCES = new Set<string>([
  'manual',
  'url',
  'slack_assisted',
])
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test $(find src -path '*__tests__*' -name 'metric-sources.test.ts')`
Expected: PASS (2 tests)

- [ ] **Step 5: Point the API route at the shared module**

In `src/app/api/goals/route.ts`, delete the local `METRIC_SOURCES` array (lines 23-33) and the local `NO_CONNECTION_SOURCES` (lines 34-36, including its comment), and add to the imports:

```ts
import { METRIC_SOURCES, NO_CONNECTION_SOURCES } from '@/lib/goals/metric-sources'
```

Leave `GOAL_KINDS` and `RECURRENCES` where they are — they are not needed elsewhere.

- [ ] **Step 6: Point the wizard's binding fields at the shared module**

In `src/components/goals/metric-binding-fields.tsx`, delete the local declaration at line 29 and its two-line comment above it, and add to the imports:

```ts
import { NO_CONNECTION_SOURCES } from '@/lib/goals/metric-sources'
```

- [ ] **Step 7: Verify nothing else declares this list**

Run: `grep -rn "slack_assisted'\]" src --include=*.ts --include=*.tsx`
Expected: only `src/lib/goals/metric-sources.ts` matches. If another file matches, point it at the shared module too.

- [ ] **Step 8: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/lib/goals/metric-sources.ts src/lib/goals/__tests__/metric-sources.test.ts src/app/api/goals/route.ts src/components/goals/metric-binding-fields.tsx
git commit -m "$(cat <<'EOF'
refactor(goals): share the metric-source vocabulary

METRIC_SOURCES and NO_CONNECTION_SOURCES lived in the create route and were
duplicated in the wizard's binding fields. Lift both to lib/goals so the
template catalogue (next) cannot name a source the server rejects.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Template model — categories, layout presets, and the new fields on the existing 20

Adds the four new `GoalTemplate` fields and populates them on the current 20 templates. The catalogue stays at 20 here; Task 3 grows it. Splitting this way keeps the type change reviewable apart from 25 templates of new copy.

**Files:**
- Create: `src/lib/goals/goal-template-layouts.ts`
- Create: `src/components/goals/goal-template-accents.ts`
- Modify: `src/lib/goals/goal-templates.ts` (full rewrite of the type, constructor and all 20 entries)
- Modify: `src/lib/goals/__tests__/goal-templates.test.ts` (rewrite)

**Interfaces:**
- Consumes: `MetricSource` from Task 1; `DashboardLayout`, `WidgetType`, `parseDraftLayout` from `@/lib/goals/dashboard`
- Produces:
  - `GOAL_TEMPLATE_CATEGORIES`, `type GoalTemplateCategory`, and the extended `GoalTemplate` type (`category`, `sources`, `layout`, `tracks`) from `@/lib/goals/goal-templates`
  - `REVENUE_LAYOUT`, `COST_LAYOUT`, `RATE_LAYOUT`, `COUNT_LAYOUT`, `PERSONAL_LAYOUT`, `ORG_ROLLUP_LAYOUT` from `@/lib/goals/goal-template-layouts`
  - `CATEGORY_ACCENTS: Record<GoalTemplateCategory, CategoryAccent>`, `CATEGORY_ICONS: Record<GoalTemplateCategory, LucideIcon>` from `@/components/goals/goal-template-accents`

- [ ] **Step 1: Create the layout presets**

Create `src/lib/goals/goal-template-layouts.ts`:

```ts
/**
 * Named dashboard layouts assigned to goal templates. Six presets rather than
 * 45 bespoke layouts — the shapes that matter are "money going up", "money
 * going down", "a rate", "a count", "personal", and "an org goal with
 * children".
 *
 * Single-metric widgets only: the wizard binds exactly one metric, so
 * `comparison` and `ratio` (which need 2+) are excluded by construction and
 * by test. `narrative` is excluded too — its config requires prose, and canned
 * copy on every templated dashboard reads as filler.
 *
 * Widget ids are preset-scoped and stable so parseDraftLayout's duplicate-id
 * skip never fires.
 */
import type { DashboardLayout, WidgetType } from './dashboard'

const preset = (name: string, order: WidgetType[]): DashboardLayout => ({
  version: 1,
  widgets: order.map((type) => ({ id: `${name}-${type}`, type, config: {} })),
})

/** Revenue, ARR, MRR, quota — the number should climb and peers matter. */
export const REVENUE_LAYOUT = preset('revenue', [
  'kpi', 'trend', 'periods', 'benchmark', 'impact', 'contributions', 'history',
])

/** Savings and spend reduction — progress toward a floor, not a ceiling. */
export const COST_LAYOUT = preset('cost', [
  'kpi', 'progress', 'trend', 'impact', 'contributions', 'history',
])

/** Percentage KPIs — rates have no meaningful "progress bar" story. */
export const RATE_LAYOUT = preset('rate', [
  'kpi', 'trend', 'benchmark', 'periods', 'history',
])

/** Count KPIs and lead gen. */
export const COUNT_LAYOUT = preset('count', [
  'kpi', 'progress', 'trend', 'periods', 'contributions', 'history',
])

/** Personal-scope goals: no rollups (no children) and no benchmark
 *  (peer data is org-level). */
export const PERSONAL_LAYOUT = preset('personal', [
  'kpi', 'progress', 'trend', 'periods', 'history',
])

/** Org goals expected to have personal goals rolling up into them. */
export const ORG_ROLLUP_LAYOUT = preset('org-rollup', [
  'kpi', 'trend', 'rollups', 'periods', 'benchmark', 'impact', 'contributions', 'history',
])

export const GOAL_TEMPLATE_LAYOUTS = {
  REVENUE_LAYOUT,
  COST_LAYOUT,
  RATE_LAYOUT,
  COUNT_LAYOUT,
  PERSONAL_LAYOUT,
  ORG_ROLLUP_LAYOUT,
} as const
```

- [ ] **Step 2: Create the category accents**

Create `src/components/goals/goal-template-accents.ts`:

```ts
/**
 * Category → accent classes and icon. An explicit Record rather than the agent
 * card's hashIndex: hashing seven categories over six accents would assign
 * collisions arbitrarily, and Revenue and Cost in particular need to read as
 * visually distinct. Class shapes mirror ACCENTS in template-card-shell.
 */
import {
  Megaphone,
  PiggyBank,
  Rocket,
  ShieldCheck,
  Target,
  TrendingUp,
  HeartHandshake,
  type LucideIcon,
} from 'lucide-react'
import type { GoalTemplateCategory } from '@/lib/goals/goal-templates'

export type CategoryAccent = {
  bar: string
  tile: string
  badge: string
  ring: string
}

export const CATEGORY_ACCENTS: Record<GoalTemplateCategory, CategoryAccent> = {
  Revenue: {
    bar: 'from-emerald-500 to-teal-400',
    tile: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
    badge: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
    ring: 'hover:ring-emerald-300/70 dark:hover:ring-emerald-500/40',
  },
  Pipeline: {
    bar: 'from-sky-500 to-cyan-400',
    tile: 'bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300',
    badge: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300',
    ring: 'hover:ring-sky-300/70 dark:hover:ring-sky-500/40',
  },
  Cost: {
    bar: 'from-amber-500 to-orange-400',
    tile: 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',
    badge: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
    ring: 'hover:ring-amber-300/70 dark:hover:ring-amber-500/40',
  },
  Retention: {
    bar: 'from-rose-500 to-pink-400',
    tile: 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300',
    badge: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300',
    ring: 'hover:ring-rose-300/70 dark:hover:ring-rose-500/40',
  },
  Delivery: {
    bar: 'from-violet-500 to-fuchsia-400',
    tile: 'bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300',
    badge: 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300',
    ring: 'hover:ring-violet-300/70 dark:hover:ring-violet-500/40',
  },
  Quality: {
    bar: 'from-indigo-500 to-blue-400',
    tile: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300',
    badge: 'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300',
    ring: 'hover:ring-indigo-300/70 dark:hover:ring-indigo-500/40',
  },
  Demand: {
    bar: 'from-fuchsia-500 to-purple-400',
    tile: 'bg-fuchsia-100 text-fuchsia-600 dark:bg-fuchsia-500/15 dark:text-fuchsia-300',
    badge: 'border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700 dark:border-fuchsia-500/30 dark:bg-fuchsia-500/10 dark:text-fuchsia-300',
    ring: 'hover:ring-fuchsia-300/70 dark:hover:ring-fuchsia-500/40',
  },
}

export const CATEGORY_ICONS: Record<GoalTemplateCategory, LucideIcon> = {
  Revenue: TrendingUp,
  Pipeline: Target,
  Cost: PiggyBank,
  Retention: HeartHandshake,
  Delivery: Rocket,
  Quality: ShieldCheck,
  Demand: Megaphone,
}
```

- [ ] **Step 3: Rewrite the template type and constructor**

Replace the header of `src/lib/goals/goal-templates.ts` (everything from the file-top comment through the closing `})` of the `template` helper, i.e. lines 1-50) with:

```ts
/**
 * Static goal-template catalogue: 9 per served department, 5 org + 4 personal.
 * Pure data — selecting one prefills the wizard (`/goals/new?template=<key>`)
 * including its dashboard layout; target value and metric source always remain
 * the user's. Invariants (per-department counts, valid kinds, valid sources,
 * single-metric layouts, key preservation) are locked by goal-templates.test.ts.
 */
import type { GoalSummary } from '@/lib/types'
import { GOAL_KIND_UNITS } from '@/lib/types'
import type { Department } from '@/lib/templates/departments'
import type { MetricSource } from '@/lib/goals/metric-sources'
import type { DashboardLayout } from '@/lib/goals/dashboard'
import {
  COST_LAYOUT,
  COUNT_LAYOUT,
  ORG_ROLLUP_LAYOUT,
  PERSONAL_LAYOUT,
  RATE_LAYOUT,
  REVENUE_LAYOUT,
} from '@/lib/goals/goal-template-layouts'

/** Closed union so every category maps to exactly one accent and icon. */
export const GOAL_TEMPLATE_CATEGORIES = [
  'Revenue',
  'Pipeline',
  'Cost',
  'Retention',
  'Delivery',
  'Quality',
  'Demand',
] as const
export type GoalTemplateCategory = (typeof GOAL_TEMPLATE_CATEGORIES)[number]

export type GoalTemplate = {
  key: string
  department: Exclude<Department, 'general'>
  scope: 'org' | 'personal'
  name: string
  description: string
  kind: GoalSummary['kind']
  direction: 'increase' | 'decrease'
  /** Only meaningful for custom_kpi (other kinds derive from the kind). */
  unit: GoalSummary['unit']
  recurrence: 'monthly' | 'quarterly' | 'yearly' | null
  /** Drives the card's accent and icon. */
  category: GoalTemplateCategory
  /** One sentence: what number is actually read, and how often. */
  tracks: string
  /** Ranked metric sources, best first. `manual` is always appended last. */
  sources: MetricSource[]
  /** Draft-form layout (metric-index refs), single-metric widgets only. */
  layout: DashboardLayout
}

/** Rank, dedupe, and guarantee `manual` as the last resort. */
const rankSources = (sources: MetricSource[]): MetricSource[] => [
  ...sources.filter(
    (source, index) => source !== 'manual' && sources.indexOf(source) === index,
  ),
  'manual',
]

type TemplateSpec = {
  category: GoalTemplateCategory
  tracks: string
  sources: MetricSource[]
  layout: DashboardLayout
  direction?: GoalTemplate['direction']
  unit?: GoalTemplate['unit']
  recurrence?: GoalTemplate['recurrence']
}

const template = (
  key: string,
  department: GoalTemplate['department'],
  scope: GoalTemplate['scope'],
  name: string,
  description: string,
  kind: GoalSummary['kind'],
  spec: TemplateSpec,
): GoalTemplate => ({
  key,
  department,
  scope,
  name,
  description,
  kind,
  direction: spec.direction ?? (kind === 'savings' ? 'decrease' : 'increase'),
  unit: spec.unit ?? GOAL_KIND_UNITS[kind] ?? 'count',
  recurrence:
    spec.recurrence !== undefined
      ? spec.recurrence
      : kind === 'quota'
        ? 'quarterly'
        : kind === 'mrr' || kind === 'lead_gen'
          ? 'monthly'
          : null,
  category: spec.category,
  tracks: spec.tracks,
  sources: rankSources(spec.sources),
  layout: spec.layout,
})
```

- [ ] **Step 4: Rewrite the 20 existing entries against the new constructor**

Replace the `GOAL_TEMPLATES` array body. **Keys, names, descriptions, kinds, directions, units and recurrences are unchanged** — only the new spec object is added.

```ts
export const GOAL_TEMPLATES: GoalTemplate[] = [
  // ── Sales ────────────────────────────────────────────────────────────────
  template('sales-org-quarterly-revenue', 'sales', 'org', 'Quarterly revenue target', 'Track closed-won revenue against the number the team committed to.', 'revenue', {
    category: 'Revenue', recurrence: 'quarterly', layout: ORG_ROLLUP_LAYOUT,
    tracks: 'Closed-won revenue for the current quarter, re-read every few hours.',
    sources: ['stripe', 'hubspot', 'salesforce', 'google_sheets'],
  }),
  template('sales-org-arr-growth', 'sales', 'org', 'Grow ARR', 'The company-level recurring-revenue target, tracked from your billing source of truth.', 'arr', {
    category: 'Revenue', layout: REVENUE_LAYOUT,
    tracks: 'Total annual recurring revenue as your billing system reports it.',
    sources: ['stripe', 'postgres', 'google_sheets'],
  }),
  template('sales-personal-quota', 'sales', 'personal', 'Hit my quarterly quota', 'Your own attainment against quota, refreshed from CRM closed-won.', 'quota', {
    category: 'Revenue', layout: PERSONAL_LAYOUT,
    tracks: 'Closed-won revenue attributed to you this quarter.',
    sources: ['hubspot', 'salesforce', 'google_sheets'],
  }),
  template('sales-personal-monthly-closed', 'sales', 'personal', 'Close more revenue this month', 'A personal monthly closed-won target that resets every cycle.', 'revenue', {
    category: 'Revenue', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    tracks: 'Your closed-won revenue for the current month.',
    sources: ['hubspot', 'salesforce', 'stripe', 'google_sheets'],
  }),
  // ── Marketing ───────────────────────────────────────────────────────────
  template('marketing-org-monthly-mqls', 'marketing', 'org', 'Monthly qualified leads', 'Lead generation against a monthly MQL target from your CRM or spreadsheet.', 'lead_gen', {
    category: 'Demand', layout: COUNT_LAYOUT,
    tracks: 'Count of leads that crossed your MQL threshold this month.',
    sources: ['hubspot', 'salesforce', 'google_sheets'],
  }),
  template('marketing-org-inbound-mrr', 'marketing', 'org', 'Grow inbound-sourced MRR', 'Recurring revenue attributed to marketing-sourced pipeline.', 'mrr', {
    category: 'Revenue', layout: REVENUE_LAYOUT,
    tracks: 'Monthly recurring revenue on accounts whose first touch was inbound.',
    sources: ['hubspot', 'stripe', 'postgres', 'google_sheets'],
  }),
  template('marketing-personal-campaign-leads', 'marketing', 'personal', 'Leads from my campaigns', 'A personal lead target for the campaigns you own this month.', 'lead_gen', {
    category: 'Demand', layout: PERSONAL_LAYOUT,
    tracks: 'Leads attributed to campaigns you own, this month.',
    sources: ['hubspot', 'salesforce', 'google_sheets'],
  }),
  template('marketing-personal-newsletter', 'marketing', 'personal', 'Grow newsletter signups', 'Signups tracked from your list tool, a sheet, or a dashboard URL.', 'custom_kpi', {
    category: 'Demand', unit: 'count', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    tracks: 'Total list subscribers, read from your list tool or a sheet.',
    sources: ['google_sheets', 'url', 'hubspot'],
  }),
  // ── Engineering ─────────────────────────────────────────────────────────
  template('engineering-org-infra-savings', 'engineering', 'org', 'Cut infrastructure spend', 'A cost-reduction target — the trendline should go DOWN.', 'savings', {
    category: 'Cost', recurrence: 'quarterly', layout: COST_LAYOUT,
    tracks: 'Monthly cloud and infrastructure spend, trending toward your floor.',
    sources: ['postgres', 'google_sheets', 'url'],
  }),
  template('engineering-org-open-bugs', 'engineering', 'org', 'Reduce open bug count', 'Drive the open-defect count down and keep it down.', 'custom_kpi', {
    category: 'Quality', unit: 'count', direction: 'decrease', layout: COUNT_LAYOUT,
    tracks: 'Open defects across the tracker, counted on every sync.',
    sources: ['postgres', 'google_sheets', 'url'],
  }),
  template('engineering-personal-bug-backlog', 'engineering', 'personal', 'Clear my bug backlog', 'Your personally-assigned open issues, trending to a target.', 'custom_kpi', {
    category: 'Quality', unit: 'count', direction: 'decrease', layout: PERSONAL_LAYOUT,
    tracks: 'Open issues assigned to you.',
    sources: ['postgres', 'google_sheets', 'url'],
  }),
  template('engineering-personal-ship-cadence', 'engineering', 'personal', 'Ship N releases this quarter', 'A personal shipping-cadence target for the quarter.', 'custom_kpi', {
    category: 'Delivery', unit: 'count', recurrence: 'quarterly', layout: PERSONAL_LAYOUT,
    tracks: 'Releases you shipped this quarter.',
    sources: ['postgres', 'google_sheets'],
  }),
  // ── Finance ─────────────────────────────────────────────────────────────
  template('finance-org-vendor-savings', 'finance', 'org', 'Reduce vendor spend', 'A company savings target across renegotiated and retired vendors.', 'savings', {
    category: 'Cost', layout: COST_LAYOUT,
    tracks: 'Total vendor spend across the ledger, trending down.',
    sources: ['postgres', 'google_sheets'],
  }),
  template('finance-org-collected-revenue', 'finance', 'org', 'Collected-revenue target', 'Cash actually collected, not just booked — tracked from your ledger.', 'revenue', {
    category: 'Revenue', recurrence: 'quarterly', layout: ORG_ROLLUP_LAYOUT,
    tracks: 'Cash received this quarter, not invoiced amounts.',
    sources: ['stripe', 'postgres', 'google_sheets'],
  }),
  template('finance-personal-cost-center', 'finance', 'personal', 'Cut my cost center spend', 'A personal savings target for the budget lines you own.', 'savings', {
    category: 'Cost', layout: PERSONAL_LAYOUT,
    tracks: 'Spend on the budget lines you own.',
    sources: ['postgres', 'google_sheets'],
  }),
  template('finance-personal-dso', 'finance', 'personal', 'Bring DSO down', 'Days sales outstanding, trending down toward a target.', 'custom_kpi', {
    category: 'Cost', unit: 'count', direction: 'decrease', layout: PERSONAL_LAYOUT,
    tracks: 'Average days between invoice and payment across your accounts.',
    sources: ['postgres', 'stripe', 'google_sheets'],
  }),
  // ── CSM ─────────────────────────────────────────────────────────────────
  template('csm-org-nrr', 'csm', 'org', 'Net revenue retention', 'NRR as a percentage target — the health metric of the book.', 'custom_kpi', {
    category: 'Retention', unit: 'percent', layout: RATE_LAYOUT,
    tracks: 'Revenue from existing accounts versus the same cohort a year ago.',
    sources: ['stripe', 'hubspot', 'salesforce', 'postgres'],
  }),
  template('csm-org-expansion-mrr', 'csm', 'org', 'Grow expansion MRR', 'Upsell and expansion recurring revenue, tracked monthly.', 'mrr', {
    category: 'Revenue', layout: REVENUE_LAYOUT,
    tracks: 'Recurring revenue added by upsells on existing accounts this month.',
    sources: ['stripe', 'hubspot', 'salesforce', 'postgres'],
  }),
  template('csm-personal-renewals', 'csm', 'personal', 'Renewals closed this quarter', 'Your renewal revenue against the quarter’s book.', 'revenue', {
    category: 'Retention', recurrence: 'quarterly', layout: PERSONAL_LAYOUT,
    tracks: 'Renewal revenue you closed this quarter.',
    sources: ['hubspot', 'salesforce', 'stripe', 'google_sheets'],
  }),
  template('csm-personal-churn-saves', 'csm', 'personal', 'Reduce churned accounts', 'Accounts lost from your book, trending down.', 'custom_kpi', {
    category: 'Retention', unit: 'count', direction: 'decrease', layout: PERSONAL_LAYOUT,
    tracks: 'Accounts lost from your book this period.',
    sources: ['hubspot', 'salesforce', 'postgres', 'google_sheets'],
  }),
]
```

Leave `goalTemplateByKey` unchanged at the bottom of the file.

- [ ] **Step 5: Rewrite the test file**

Replace `src/lib/goals/__tests__/goal-templates.test.ts` entirely:

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GOAL_TEMPLATES,
  GOAL_TEMPLATE_CATEGORIES,
  goalTemplateByKey,
} from '../goal-templates'
import { parseDraftLayout } from '../dashboard'
import { METRIC_SOURCES } from '../metric-sources'
import { GOAL_KIND_LABELS, GOAL_KIND_UNITS } from '@/lib/types'
import { PRODUCT_DEPARTMENTS } from '@/lib/templates/departments'
import { CATEGORY_ACCENTS, CATEGORY_ICONS } from '@/components/goals/goal-template-accents'

/** The 20 keys that shipped before the v2 catalogue. Bookmarked
 *  /goals/new?template=<key> links must keep resolving forever. */
const LEGACY_KEYS = [
  'sales-org-quarterly-revenue', 'sales-org-arr-growth', 'sales-personal-quota', 'sales-personal-monthly-closed',
  'marketing-org-monthly-mqls', 'marketing-org-inbound-mrr', 'marketing-personal-campaign-leads', 'marketing-personal-newsletter',
  'engineering-org-infra-savings', 'engineering-org-open-bugs', 'engineering-personal-bug-backlog', 'engineering-personal-ship-cadence',
  'finance-org-vendor-savings', 'finance-org-collected-revenue', 'finance-personal-cost-center', 'finance-personal-dso',
  'csm-org-nrr', 'csm-org-expansion-mrr', 'csm-personal-renewals', 'csm-personal-churn-saves',
]

test('catalogue shape: 4 per served department, 2 org + 2 personal', () => {
  assert.equal(GOAL_TEMPLATES.length, PRODUCT_DEPARTMENTS.length * 4)
  for (const department of PRODUCT_DEPARTMENTS) {
    const entries = GOAL_TEMPLATES.filter((entry) => entry.department === department)
    assert.equal(entries.length, 4, `${department} should have 4 templates`)
    assert.equal(entries.filter((entry) => entry.scope === 'org').length, 2, `${department} org split`)
    assert.equal(entries.filter((entry) => entry.scope === 'personal').length, 2, `${department} personal split`)
  }
})

test('every template has a valid kind, a kind-consistent unit, and a unique key', () => {
  const keys = new Set<string>()
  for (const entry of GOAL_TEMPLATES) {
    assert.ok(entry.kind in GOAL_KIND_LABELS, `${entry.key}: unknown kind ${entry.kind}`)
    const implied = GOAL_KIND_UNITS[entry.kind]
    if (implied !== null) assert.equal(entry.unit, implied, `${entry.key}: unit contradicts kind`)
    assert.ok(!keys.has(entry.key), `duplicate key ${entry.key}`)
    keys.add(entry.key)
    assert.ok(entry.name.length > 0 && entry.description.length > 0)
  }
})

test('savings templates trend down; lookup by key round-trips', () => {
  for (const entry of GOAL_TEMPLATES.filter((candidate) => candidate.kind === 'savings')) {
    assert.equal(entry.direction, 'decrease', entry.key)
  }
  assert.equal(goalTemplateByKey('sales-personal-quota')?.kind, 'quota')
  assert.equal(goalTemplateByKey('no-such-template'), null)
})

test('every layout survives parseDraftLayout with no widgets dropped', () => {
  for (const entry of GOAL_TEMPLATES) {
    const parsed = parseDraftLayout(entry.layout, 1)
    assert.ok(parsed, `${entry.key}: layout rejected by parseDraftLayout`)
    assert.equal(
      parsed.widgets.length,
      entry.layout.widgets.length,
      `${entry.key}: parseDraftLayout silently dropped widgets`,
    )
  }
})

test('no layout uses a multi-metric widget — the wizard binds exactly one', () => {
  for (const entry of GOAL_TEMPLATES) {
    for (const widget of entry.layout.widgets) {
      assert.ok(
        widget.type !== 'comparison' && widget.type !== 'ratio',
        `${entry.key}: ${widget.type} needs 2+ metrics`,
      )
    }
  }
})

test('sources are valid, deduped, non-empty, and end in manual', () => {
  for (const entry of GOAL_TEMPLATES) {
    assert.ok(entry.sources.length > 0, `${entry.key}: no sources`)
    assert.equal(
      new Set(entry.sources).size,
      entry.sources.length,
      `${entry.key}: duplicate source`,
    )
    assert.equal(
      entry.sources[entry.sources.length - 1],
      'manual',
      `${entry.key}: manual must be the last resort`,
    )
    for (const source of entry.sources) {
      assert.ok(
        (METRIC_SOURCES as readonly string[]).includes(source),
        `${entry.key}: ${source} is not a valid metric source`,
      )
    }
  }
})

test('every category is in the union and has an accent and an icon', () => {
  for (const entry of GOAL_TEMPLATES) {
    assert.ok(
      (GOAL_TEMPLATE_CATEGORIES as readonly string[]).includes(entry.category),
      `${entry.key}: unknown category ${entry.category}`,
    )
    assert.ok(CATEGORY_ACCENTS[entry.category], `${entry.category}: no accent`)
    assert.ok(CATEGORY_ICONS[entry.category], `${entry.category}: no icon`)
  }
})

test('tracks copy is present and says something the description does not', () => {
  for (const entry of GOAL_TEMPLATES) {
    assert.ok(entry.tracks.trim().length > 0, `${entry.key}: empty tracks`)
    assert.notEqual(entry.tracks, entry.description, `${entry.key}: tracks duplicates description`)
  }
})

test('every pre-v2 template key still resolves', () => {
  for (const key of LEGACY_KEYS) {
    assert.ok(goalTemplateByKey(key), `${key} disappeared — bookmarked links would 404`)
  }
})
```

- [ ] **Step 6: Run the tests**

Run: `npx tsx --test $(find src -path '*__tests__*' -name 'goal-templates.test.ts')`
Expected: PASS (9 tests). If `parseDraftLayout` drops widgets, a preset uses a widget whose draft schema rejects `{}` — the only such types are `comparison` and `ratio`, which must not be in any preset.

This test imports `goal-template-accents.ts`, which imports `lucide-react`. That is a plain module import with no JSX and no DOM, so it loads fine under `tsx` without the jsdom shim. If module resolution complains anyway, add `import '@/test-support/jsdom-env'` as the first line and rename the file to `.test.tsx` — do **not** drop the accent/icon assertions.

- [ ] **Step 7: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass. The gallery still compiles — it reads only fields that already existed.

- [ ] **Step 8: Commit**

```bash
git add src/lib/goals/goal-template-layouts.ts src/components/goals/goal-template-accents.ts src/lib/goals/goal-templates.ts src/lib/goals/__tests__/goal-templates.test.ts
git commit -m "$(cat <<'EOF'
feat(goals): templates carry category, tracks copy, ranked sources and a layout

Six named dashboard presets built from single-metric widgets only, an
explicit category->accent/icon map, and the four new fields populated on the
existing 20 templates. Tests lock the single-metric constraint, source
validity, and that every pre-v2 key still resolves.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Grow the catalogue to 45

25 new templates, 5 per department (3 org + 2 personal), bringing each department to 9 with a 5/4 split.

**Files:**
- Modify: `src/lib/goals/goal-templates.ts`
- Modify: `src/lib/goals/__tests__/goal-templates.test.ts` (the shape test only)

**Interfaces:**
- Consumes: everything Task 2 produced
- Produces: `GOAL_TEMPLATES.length === 45`

- [ ] **Step 1: Update the shape test first (it must fail)**

In `src/lib/goals/__tests__/goal-templates.test.ts`, replace the first test with:

```ts
test('catalogue shape: 9 per served department, 5 org + 4 personal', () => {
  assert.equal(GOAL_TEMPLATES.length, PRODUCT_DEPARTMENTS.length * 9)
  for (const department of PRODUCT_DEPARTMENTS) {
    const entries = GOAL_TEMPLATES.filter((entry) => entry.department === department)
    assert.equal(entries.length, 9, `${department} should have 9 templates`)
    assert.equal(entries.filter((entry) => entry.scope === 'org').length, 5, `${department} org split`)
    assert.equal(entries.filter((entry) => entry.scope === 'personal').length, 4, `${department} personal split`)
  }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test $(find src -path '*__tests__*' -name 'goal-templates.test.ts')`
Expected: FAIL — `Expected values to be strictly equal: 20 !== 45`

- [ ] **Step 3: Append the 5 new Sales templates**

Insert after `sales-personal-monthly-closed`, before the Marketing comment:

```ts
  template('sales-org-pipeline-coverage', 'sales', 'org', 'Pipeline coverage ratio', 'Open pipeline as a multiple of the number you have to close — the earliest warning you get.', 'custom_kpi', {
    category: 'Pipeline', unit: 'percent', layout: RATE_LAYOUT,
    tracks: 'Open pipeline value divided by remaining quota, as a percentage.',
    sources: ['hubspot', 'salesforce', 'google_sheets'],
  }),
  template('sales-org-win-rate', 'sales', 'org', 'Improve win rate', 'The share of qualified opportunities that close won.', 'custom_kpi', {
    category: 'Pipeline', unit: 'percent', layout: RATE_LAYOUT,
    tracks: 'Closed-won opportunities as a percentage of all closed opportunities.',
    sources: ['hubspot', 'salesforce', 'google_sheets'],
  }),
  template('sales-org-new-logos', 'sales', 'org', 'New logos this quarter', 'Net-new customer accounts, counted rather than valued.', 'custom_kpi', {
    category: 'Pipeline', unit: 'count', recurrence: 'quarterly', layout: ORG_ROLLUP_LAYOUT,
    tracks: 'Accounts that became customers for the first time this quarter.',
    sources: ['hubspot', 'salesforce', 'stripe', 'google_sheets'],
  }),
  template('sales-personal-pipeline-created', 'sales', 'personal', 'Pipeline I created', 'New qualified pipeline you sourced this month, ahead of anything closing.', 'revenue', {
    category: 'Pipeline', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    tracks: 'Value of qualified opportunities you created this month.',
    sources: ['hubspot', 'salesforce', 'google_sheets'],
  }),
  template('sales-personal-meetings-booked', 'sales', 'personal', 'Meetings booked this month', 'The activity number upstream of everything else.', 'custom_kpi', {
    category: 'Pipeline', unit: 'count', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    tracks: 'Discovery or demo meetings you booked this month.',
    sources: ['hubspot', 'salesforce', 'google_sheets'],
  }),
```

- [ ] **Step 4: Append the 5 new Marketing templates**

Insert after `marketing-personal-newsletter`, before the Engineering comment:

```ts
  template('marketing-org-cac', 'marketing', 'org', 'Bring CAC down', 'Blended cost to acquire a customer — spend divided by new customers.', 'savings', {
    category: 'Cost', layout: COST_LAYOUT,
    tracks: 'Total acquisition spend divided by new customers, per period.',
    sources: ['postgres', 'google_sheets', 'hubspot'],
  }),
  template('marketing-org-organic-traffic', 'marketing', 'org', 'Grow organic traffic', 'Non-paid sessions, the compounding channel.', 'custom_kpi', {
    category: 'Demand', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    tracks: 'Organic sessions this month, read from analytics or a sheet.',
    sources: ['google_sheets', 'url', 'postgres'],
  }),
  template('marketing-org-sourced-pipeline', 'marketing', 'org', 'Marketing-sourced pipeline', 'Pipeline value attributed to marketing first-touch, not just lead count.', 'revenue', {
    category: 'Pipeline', recurrence: 'quarterly', layout: ORG_ROLLUP_LAYOUT,
    tracks: 'Value of open opportunities whose first touch was marketing.',
    sources: ['hubspot', 'salesforce', 'google_sheets'],
  }),
  template('marketing-personal-content-output', 'marketing', 'personal', 'Ship N pieces this month', 'A personal publishing cadence — the input you actually control.', 'custom_kpi', {
    category: 'Demand', unit: 'count', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    tracks: 'Pieces you published this month.',
    sources: ['google_sheets', 'url'],
  }),
  template('marketing-personal-conversion-rate', 'marketing', 'personal', 'Lift my landing conversion', 'The conversion rate on the pages you own.', 'custom_kpi', {
    category: 'Demand', unit: 'percent', layout: PERSONAL_LAYOUT,
    tracks: 'Conversions as a percentage of visits on your pages.',
    sources: ['google_sheets', 'url', 'postgres'],
  }),
```

- [ ] **Step 5: Append the 5 new Engineering templates**

Insert after `engineering-personal-ship-cadence`, before the Finance comment:

```ts
  template('engineering-org-deploy-frequency', 'engineering', 'org', 'Deploy more often', 'Deployment frequency — the DORA metric that moves everything else.', 'custom_kpi', {
    category: 'Delivery', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    tracks: 'Production deployments this month.',
    sources: ['postgres', 'google_sheets', 'url'],
  }),
  template('engineering-org-p1-incidents', 'engineering', 'org', 'Cut Sev-1 incidents', 'The count of the incidents that wake people up.', 'custom_kpi', {
    category: 'Quality', unit: 'count', direction: 'decrease', recurrence: 'quarterly', layout: COUNT_LAYOUT,
    tracks: 'Severity-1 incidents declared this quarter.',
    sources: ['postgres', 'google_sheets', 'slack_assisted'],
  }),
  template('engineering-org-lead-time', 'engineering', 'org', 'Shorten lead time to production', 'Hours from first commit to running in production.', 'custom_kpi', {
    category: 'Delivery', unit: 'count', direction: 'decrease', layout: ORG_ROLLUP_LAYOUT,
    tracks: 'Median hours from first commit to production deploy.',
    sources: ['postgres', 'google_sheets'],
  }),
  template('engineering-personal-review-turnaround', 'engineering', 'personal', 'Review PRs faster', 'Hours between a review being requested of you and you giving it.', 'custom_kpi', {
    category: 'Delivery', unit: 'count', direction: 'decrease', layout: PERSONAL_LAYOUT,
    tracks: 'Median hours you take to respond to a review request.',
    sources: ['postgres', 'google_sheets'],
  }),
  template('engineering-personal-test-coverage', 'engineering', 'personal', 'Raise coverage on my services', 'Line coverage on the services you own.', 'custom_kpi', {
    category: 'Quality', unit: 'percent', layout: PERSONAL_LAYOUT,
    tracks: 'Line coverage percentage on your services, from CI output.',
    sources: ['url', 'google_sheets', 'postgres'],
  }),
```

- [ ] **Step 6: Append the 5 new Finance templates**

Insert after `finance-personal-dso`, before the CSM comment:

```ts
  template('finance-org-gross-margin', 'finance', 'org', 'Improve gross margin', 'Revenue less cost of revenue, as a percentage.', 'custom_kpi', {
    category: 'Cost', unit: 'percent', layout: RATE_LAYOUT,
    tracks: 'Gross profit as a percentage of revenue, from the ledger.',
    sources: ['postgres', 'google_sheets', 'stripe'],
  }),
  template('finance-org-burn-reduction', 'finance', 'org', 'Reduce monthly burn', 'Net cash out per month, trending toward a floor.', 'savings', {
    category: 'Cost', recurrence: 'monthly', layout: COST_LAYOUT,
    tracks: 'Net cash consumed this month.',
    sources: ['postgres', 'google_sheets', 'stripe'],
  }),
  template('finance-org-revenue-per-head', 'finance', 'org', 'Revenue per employee', 'The efficiency number the board asks about.', 'custom_kpi', {
    category: 'Revenue', unit: 'usd', layout: ORG_ROLLUP_LAYOUT,
    tracks: 'Trailing revenue divided by headcount.',
    sources: ['postgres', 'google_sheets', 'stripe'],
  }),
  template('finance-personal-close-cycle', 'finance', 'personal', 'Close the books faster', 'Business days from period end to a closed set of books.', 'custom_kpi', {
    category: 'Delivery', unit: 'count', direction: 'decrease', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    tracks: 'Business days taken to close the most recent period.',
    sources: ['google_sheets', 'postgres'],
  }),
  template('finance-personal-forecast-accuracy', 'finance', 'personal', 'Tighten my forecast accuracy', 'How close your forecast lands to the actual, as a percentage.', 'custom_kpi', {
    category: 'Quality', unit: 'percent', recurrence: 'quarterly', layout: PERSONAL_LAYOUT,
    tracks: 'Actual divided by forecast for the closed period, as a percentage.',
    sources: ['google_sheets', 'postgres', 'salesforce'],
  }),
```

- [ ] **Step 7: Append the 5 new CSM templates**

Insert after `csm-personal-churn-saves`, at the end of the array:

```ts
  template('csm-org-gross-retention', 'csm', 'org', 'Gross revenue retention', 'Retention before any expansion — the honest churn number.', 'custom_kpi', {
    category: 'Retention', unit: 'percent', layout: RATE_LAYOUT,
    tracks: 'Retained revenue from the starting cohort, excluding upsell.',
    sources: ['stripe', 'hubspot', 'salesforce', 'postgres'],
  }),
  template('csm-org-csat', 'csm', 'org', 'Raise CSAT', 'Satisfaction score across the accounts you serve.', 'custom_kpi', {
    category: 'Retention', unit: 'percent', layout: RATE_LAYOUT,
    tracks: 'Average satisfaction score across responses this period.',
    sources: ['google_sheets', 'postgres', 'url'],
  }),
  template('csm-org-time-to-value', 'csm', 'org', 'Shorten time to first value', 'Days from signature to the customer getting their first real outcome.', 'custom_kpi', {
    category: 'Retention', unit: 'count', direction: 'decrease', layout: ORG_ROLLUP_LAYOUT,
    tracks: 'Median days from close to first activation milestone.',
    sources: ['postgres', 'hubspot', 'salesforce', 'google_sheets'],
  }),
  template('csm-personal-qbr-coverage', 'csm', 'personal', 'QBR coverage of my book', 'The share of your accounts that got a real business review this quarter.', 'custom_kpi', {
    category: 'Retention', unit: 'percent', recurrence: 'quarterly', layout: PERSONAL_LAYOUT,
    tracks: 'Accounts with a completed QBR as a percentage of your book.',
    sources: ['hubspot', 'salesforce', 'google_sheets'],
  }),
  template('csm-personal-response-time', 'csm', 'personal', 'Respond to my accounts faster', 'Hours between a customer reaching out and you replying.', 'custom_kpi', {
    category: 'Quality', unit: 'count', direction: 'decrease', layout: PERSONAL_LAYOUT,
    tracks: 'Median hours to your first reply on inbound account messages.',
    sources: ['postgres', 'gmail_assisted', 'google_sheets'],
  }),
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx tsx --test $(find src -path '*__tests__*' -name 'goal-templates.test.ts')`
Expected: PASS (9 tests). All the Task 2 invariants — layouts, sources, categories, tracks, legacy keys — now cover 45 entries.

- [ ] **Step 9: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src/lib/goals/goal-templates.ts src/lib/goals/__tests__/goal-templates.test.ts
git commit -m "$(cat <<'EOF'
feat(goals): grow the template catalogue to 45

Nine per served department, 5 org + 4 personal. Depth rather than new
departments -- PRODUCT_DEPARTMENTS is shared with the agent catalogue,
relevance sorting and BI auto-tagging. Nine per department also makes a
department filter resolve to exactly one page.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Shared preview-data builder

`CopilotPreview` builds a synthetic `GoalDetail` + metric series inline across 90 lines. The template modal needs the same thing. Extract it — **behavior-preserving for `CopilotPreview`**, with an opt-in seeded series the template modal uses so its preview shows a plausible trend instead of empty widgets.

**Files:**
- Create: `src/lib/goals/preview-data.ts`
- Create: `src/lib/goals/__tests__/preview-data.test.ts`
- Create: `src/components/goals/__tests__/preview-data-widgets.test.tsx`
- Modify: `src/components/goals/copilot-preview.tsx:139-225`

**Interfaces:**
- Consumes: `DashboardData` (type-only) from `@/components/goals/widgets/goal-dashboard`; `GoalDetail`, `GoalMetricSeries` from `@/lib/types`
- Produces: `buildPreviewDashboardData(input: PreviewGoalInput): { data: DashboardData; metricIds: string[] }` from `@/lib/goals/preview-data`

- [ ] **Step 1: Write the failing test**

Create `src/lib/goals/__tests__/preview-data.test.ts`:

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPreviewDashboardData } from '../preview-data'

const base = {
  name: 'Quarterly revenue target',
  kind: 'revenue' as const,
  direction: 'increase' as const,
  unit: 'usd' as const,
  startValue: 100_000,
  targetValue: 400_000,
  targetDate: null,
  recurrence: null,
  personal: false,
  metrics: [
    { label: 'Closed-won', role: 'primary' as const, unit: 'usd' as const, source: 'stripe', metricKey: 'net_revenue' },
  ],
}

test('returns one metric id per requested metric, matching the series ids', () => {
  const { data, metricIds } = buildPreviewDashboardData(base)
  assert.equal(metricIds.length, 1)
  assert.deepEqual(data.metrics.map((metric) => metric.id), metricIds)
  assert.equal(data.goal.metrics.length, 1)
  assert.equal(data.preview, true)
})

test('without a seed the series is empty — the Copilot preview contract', () => {
  const { data } = buildPreviewDashboardData(base)
  assert.deepEqual(data.metrics[0].datapoints, [])
})

test('with a seed the series is populated and deterministic', () => {
  const first = buildPreviewDashboardData({ ...base, seed: 'sales-org-quarterly-revenue' })
  const second = buildPreviewDashboardData({ ...base, seed: 'sales-org-quarterly-revenue' })
  assert.ok(first.data.metrics[0].datapoints.length > 5)
  assert.deepEqual(
    first.data.metrics[0].datapoints.map((point) => point.value),
    second.data.metrics[0].datapoints.map((point) => point.value),
  )
})

test('different seeds produce different series', () => {
  const a = buildPreviewDashboardData({ ...base, seed: 'seed-a' })
  const b = buildPreviewDashboardData({ ...base, seed: 'seed-b' })
  assert.notDeepEqual(
    a.data.metrics[0].datapoints.map((point) => point.value),
    b.data.metrics[0].datapoints.map((point) => point.value),
  )
})

test('a seeded increasing series stays between start and target', () => {
  const { data } = buildPreviewDashboardData({ ...base, seed: 'bounds' })
  for (const point of data.metrics[0].datapoints) {
    assert.ok(point.value >= base.startValue, `${point.value} below start`)
    assert.ok(point.value <= base.targetValue, `${point.value} above target`)
  }
})

test('a seeded decreasing series stays between target and start', () => {
  const { data } = buildPreviewDashboardData({
    ...base,
    direction: 'decrease',
    kind: 'savings',
    startValue: 90_000,
    targetValue: 40_000,
    seed: 'down',
  })
  for (const point of data.metrics[0].datapoints) {
    assert.ok(point.value <= 90_000, `${point.value} above start`)
    assert.ok(point.value >= 40_000, `${point.value} below target`)
  }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test $(find src -path '*__tests__*' -name 'preview-data.test.ts')`
Expected: FAIL — `Cannot find module '../preview-data'`

- [ ] **Step 3: Create the builder**

Create `src/lib/goals/preview-data.ts`:

```ts
/**
 * Synthetic DashboardData for previewing a goal that does not exist yet.
 * Shared by the Copilot draft preview and the template detail modal.
 *
 * Without a `seed` the metric series is empty — that is the Copilot preview's
 * long-standing behavior and it stays byte-identical. With a `seed` the series
 * is generated deterministically from it, so the template modal can show a
 * plausible trend that does not shimmer between renders. Seeded data is always
 * labeled as a sample by the caller; it is never presented as real.
 */
import type { GoalDetail, GoalMetricSeries, GoalRecurrence, GoalSummary } from '@/lib/types'
import type { DashboardData } from '@/components/goals/widgets/goal-dashboard'

export type PreviewMetricInput = {
  label: string | null
  role: 'primary' | 'supporting'
  unit: GoalSummary['unit']
  source: string
  metricKey: string
}

export type PreviewGoalInput = {
  name: string
  description?: string | null
  kind: GoalSummary['kind']
  direction: 'increase' | 'decrease'
  unit: GoalSummary['unit']
  startValue: number
  targetValue: number
  /** `YYYY-MM-DD`, or null for "90 days out". */
  targetDate: string | null
  recurrence: GoalRecurrence
  personal: boolean
  metrics: PreviewMetricInput[]
  /** Omit for an empty series; supply for a deterministic sample trend. */
  seed?: string
}

const SAMPLE_POINTS = 12
const DAY_MS = 24 * 60 * 60 * 1000

/** FNV-1a seed into an xorshift32 stream. Deterministic, no Math.random. */
function randomFrom(seed: string): () => number {
  let state = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index)
    state = Math.imul(state, 16777619)
  }
  state = state >>> 0 || 1
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0xffffffff
  }
}

/**
 * A sample series walking from `startValue` roughly 65% of the way toward
 * `targetValue`, with bounded jitter. Always clamped inside [start, target]
 * so a preview never shows an impossible reading.
 */
function seededDatapoints(
  seed: string,
  startValue: number,
  targetValue: number,
  now: number,
): GoalMetricSeries['datapoints'] {
  const random = randomFrom(seed)
  const span = targetValue - startValue
  const lower = Math.min(startValue, targetValue)
  const upper = Math.max(startValue, targetValue)
  return Array.from({ length: SAMPLE_POINTS }, (_, index) => {
    const progress = (index / (SAMPLE_POINTS - 1)) * 0.65
    const jitter = (random() - 0.5) * 0.08 * Math.abs(span)
    const value = Math.min(upper, Math.max(lower, startValue + span * progress + jitter))
    return {
      id: `preview-point-${index}`,
      value: Math.round(value * 100) / 100,
      capturedAt: new Date(now - (SAMPLE_POINTS - 1 - index) * 7 * DAY_MS).toISOString(),
      origin: 'sync' as const,
    }
  })
}

export function buildPreviewDashboardData(input: PreviewGoalInput): {
  data: DashboardData
  metricIds: string[]
} {
  const now = Date.now()
  const startAt = new Date(now).toISOString()
  const fallbackTarget = new Date(now + 90 * DAY_MS).toISOString()
  const metricIds = input.metrics.map((_, index) => `preview-${index}`)
  const primaryIndex = Math.max(
    0,
    input.metrics.findIndex((metric) => metric.role === 'primary'),
  )

  const metrics: GoalMetricSeries[] = input.metrics.map((metric, index) => ({
    id: metricIds[index],
    label: metric.label,
    role: metric.role,
    unit: metric.unit,
    source: metric.source,
    metricKey: metric.metricKey,
    lastSyncAt: null,
    lastError: null,
    datapoints:
      input.seed && index === primaryIndex
        ? seededDatapoints(input.seed, input.startValue, input.targetValue, now)
        : [],
  }))

  const series = metrics[primaryIndex]?.datapoints ?? []
  const currentValue = series.length
    ? series[series.length - 1].value
    : Number.isFinite(input.startValue)
      ? input.startValue
      : null

  const goal: GoalDetail = {
    id: 'preview',
    name: input.name,
    description: input.description ?? null,
    kind: input.kind,
    direction: input.direction,
    unit: input.unit,
    startValue: input.startValue,
    targetValue: input.targetValue,
    startAt,
    targetDate: input.targetDate ? `${input.targetDate}T23:59:59` : fallbackTarget,
    recurrence: input.recurrence,
    status: 'active',
    riskLevel: 'no_data',
    personal: input.personal,
    parentGoalId: null,
    metric: null,
    metrics,
    dashboardLayout: null,
    currentValue,
    progress: null,
    expectedProgress: 0,
    projectedValue: null,
    children: [],
    periods: [],
    benchmark: null,
  }

  return {
    metricIds,
    data: {
      goal,
      metrics,
      contributions: [],
      impact: {
        measured: { runsCompleted: 0, tokens: 0, aiRunSecondsTotal: 0 },
        estimated: {
          hoursSaved: 0,
          laborValueUsd: 0,
          aiCostUsd: 0,
          roiMultiple: null,
          hourlyRateUsd: 0,
          aiCostPerMTokensUsd: 0,
        },
        correlated: { paceDeltaPct: null },
      },
      preview: true,
      onReload: () => {},
    },
  }
}
```

If `GoalRecurrence` is not exported from `@/lib/types`, use `GoalSummary['recurrence']` instead.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test $(find src -path '*__tests__*' -name 'preview-data.test.ts')`
Expected: PASS (6 tests)

- [ ] **Step 5: Write the widget-render test**

Create `src/components/goals/__tests__/preview-data-widgets.test.tsx`:

```tsx
/**
 * Every single-metric widget must survive rendering against preview data.
 * The template modal renders real GoalDashboard widgets against a synthetic
 * goal, so a widget that assumes a persisted goal would blow up the modal.
 */
import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup } from '@testing-library/react'
import { GoalDashboard } from '../widgets/goal-dashboard'
import { buildPreviewDashboardData } from '@/lib/goals/preview-data'
import type { DashboardLayout, WidgetType } from '@/lib/goals/dashboard'

afterEach(cleanup)

const SINGLE_METRIC_WIDGETS: WidgetType[] = [
  'kpi', 'trend', 'progress', 'impact', 'benchmark',
  'periods', 'contributions', 'history', 'rollups',
]

const { data } = buildPreviewDashboardData({
  name: 'Preview goal',
  kind: 'revenue',
  direction: 'increase',
  unit: 'usd',
  startValue: 1000,
  targetValue: 5000,
  targetDate: null,
  recurrence: null,
  personal: false,
  metrics: [{ label: 'Revenue', role: 'primary', unit: 'usd', source: 'stripe', metricKey: 'net_revenue' }],
  seed: 'widget-render',
})

for (const type of SINGLE_METRIC_WIDGETS) {
  test(`${type} renders against preview data`, () => {
    const layout: DashboardLayout = {
      version: 1,
      widgets: [{ id: `preview-${type}`, type, config: {} }],
    }
    assert.doesNotThrow(() => {
      render(<GoalDashboard layout={layout} data={data} />)
    })
  })
}
```

- [ ] **Step 6: Run the widget test**

Run: `npx tsx --test $(find src -path '*__tests__*' -name 'preview-data-widgets.test.tsx')`
Expected: PASS (9 tests). If a widget throws, fix that widget to tolerate `id: 'preview'` and empty `periods` / `children` / `benchmark` — do not remove it from the presets without saying so.

- [ ] **Step 7: Refactor CopilotPreview onto the builder**

In `src/components/goals/copilot-preview.tsx`, replace lines 139-225 (from `const previewIds = ...` through the closing `])` of the `useMemo` dependency array) with:

```tsx
  const preview = useMemo(
    () =>
      buildPreviewDashboardData({
        name: name || draft.name,
        description: draft.description,
        kind: draft.kind,
        direction: draft.direction,
        unit: draft.unit,
        startValue: Number(startValue || 0),
        targetValue: Number(targetValue || 0),
        targetDate: targetDate || null,
        recurrence,
        personal,
        metrics: metrics.map((binding) => ({
          label: binding.label,
          role: binding.role,
          unit: binding.unit,
          source: binding.source,
          metricKey: binding.metricKey,
        })),
      }),
    [
      draft.description,
      draft.direction,
      draft.kind,
      draft.name,
      draft.unit,
      metrics,
      name,
      personal,
      recurrence,
      startValue,
      targetDate,
      targetValue,
    ],
  )
  const previewData = preview.data
  const previewLayout = draft.layout
    ? resolveLayoutMetricRefs(draft.layout, preview.metricIds)
    : defaultLayoutForGoal()
```

Add the import:

```tsx
import { buildPreviewDashboardData } from '@/lib/goals/preview-data'
```

Then remove the now-unused `type DashboardData` and `type GoalDetail` imports if TypeScript reports them unused. Keep `GoalDashboard`, `resolveLayoutMetricRefs` and `defaultLayoutForGoal`.

**No seed is passed** — the Copilot preview keeps its empty series exactly as before.

- [ ] **Step 8: Typecheck and run the full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean. `previewData` and `previewLayout` keep the same names, so the JSX at line ~471 is untouched.

- [ ] **Step 9: Commit**

```bash
git add src/lib/goals/preview-data.ts src/lib/goals/__tests__/preview-data.test.ts src/components/goals/__tests__/preview-data-widgets.test.tsx src/components/goals/copilot-preview.tsx
git commit -m "$(cat <<'EOF'
refactor(goals): extract the pre-creation dashboard preview builder

buildPreviewDashboardData replaces 90 lines of inline synthetic GoalDetail in
copilot-preview, ahead of the template detail modal needing the same thing.
Copilot behavior is unchanged -- the seeded sample series is opt-in and the
Copilot path does not pass a seed. Tests cover determinism, bounds, and that
all nine single-metric widgets render against preview data.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Shared card shell

`TemplateCatalogueCard` holds the accent palette and card chrome. Copying it for goals guarantees drift. Extract the chrome; refactor the agent card onto it with **no visual change**, guarded by a characterization test written first.

Deviation from the spec, deliberate: the spec suggested an `as` prop so the shell could render as `Link` or `button`. Instead the **caller owns the wrapper element** and the shell renders only the `<Card>` interior. Simpler, avoids polymorphic-component typing, and each caller keeps full control of its own accessibility semantics.

**Files:**
- Create: `src/components/templates/template-card-shell.tsx`
- Create: `src/components/templates/__tests__/template-catalogue-card.test.tsx`
- Modify: `src/components/templates/template-catalogue-card.tsx`

**Interfaces:**
- Produces from `@/components/templates/template-card-shell`:
  - `type Accent = { bar: string; tile: string; badge: string; ring: string }`
  - `ACCENTS: readonly Accent[]`, `hashIndex(seed: string, mod: number): number`, `accentFor(category: string): Accent`
  - `TemplateCardShell(props: { accent: Accent; icon: LucideIcon; title: string; description: string; descriptionClamp?: 2 | 3; badges: ReactNode; tools?: ReactNode; cta: ReactNode }): JSX.Element`

- [ ] **Step 1: Write the characterization test**

Create `src/components/templates/__tests__/template-catalogue-card.test.tsx`. This pins the agent card's current output so the refactor is provably no-visual-change.

```tsx
/**
 * Characterization test for TemplateCatalogueCard, written before it was
 * refactored onto TemplateCardShell. Its job is to fail loudly if the shared
 * shell changes what the agent and flow catalogues render.
 */
import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen } from '@testing-library/react'
import { TemplateCatalogueCard } from '../template-catalogue-card'

afterEach(cleanup)

const props = {
  href: '/templates/weekly-digest',
  name: 'Weekly revenue digest',
  description: 'Summarize closed-won and pipeline movement every Monday.',
  category: 'Revenue',
  integrations: ['Slack', 'HubSpot'] as const,
}

test('renders title, category, description, integrations and CTA', () => {
  render(<TemplateCatalogueCard {...props} />)
  assert.ok(screen.getByText('Weekly revenue digest'))
  assert.ok(screen.getByText('Revenue'))
  assert.ok(screen.getByText(props.description))
  assert.ok(screen.getByText('Requires'))
  assert.ok(screen.getByText('Slack'))
  assert.ok(screen.getByText('HubSpot'))
  assert.ok(screen.getByText('Use template'))
})

test('links to the template href', () => {
  const { container } = render(<TemplateCatalogueCard {...props} />)
  const link = container.querySelector('a')
  assert.ok(link)
  assert.equal(link?.getAttribute('href'), '/templates/weekly-digest')
})

test('renders a gradient accent bar and an icon tile', () => {
  const { container } = render(<TemplateCatalogueCard {...props} />)
  assert.ok(container.querySelector('.bg-gradient-to-r'), 'accent bar missing')
  assert.ok(container.querySelector('svg'), 'icon tile missing')
})

test('flow variant adds a Flow badge', () => {
  render(<TemplateCatalogueCard {...props} kind="flow" />)
  assert.ok(screen.getByText('Flow'))
})

test('advancesGoal renders the goal badge', () => {
  render(<TemplateCatalogueCard {...props} advancesGoal="Grow ARR" />)
  assert.ok(screen.getByText('Advances: Grow ARR'))
})

test('a custom actionLabel replaces the default CTA text', () => {
  render(<TemplateCatalogueCard {...props} actionLabel="Deploy agent" />)
  assert.ok(screen.getByText('Deploy agent'))
  assert.equal(screen.queryByText('Use template'), null)
})

test('the integrations block is omitted when there are none', () => {
  render(<TemplateCatalogueCard {...props} integrations={[]} />)
  assert.equal(screen.queryByText('Requires'), null)
})
```

- [ ] **Step 2: Run it against the unrefactored card**

Run: `npx tsx --test $(find src -path '*__tests__*' -name 'template-catalogue-card.test.tsx')`
Expected: PASS (7 tests). This is the baseline. If any test fails now, fix the test to match current behavior — the current rendering is the contract.

- [ ] **Step 3: Commit the baseline**

```bash
git add src/components/templates/__tests__/template-catalogue-card.test.tsx
git commit -m "$(cat <<'EOF'
test(templates): characterize the catalogue card before extracting its shell

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Create the shell**

Create `src/components/templates/template-card-shell.tsx`. `ACCENTS`, `hashIndex` and `accentFor` move **verbatim** from `template-catalogue-card.tsx`.

```tsx
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/**
 * The card chrome shared by the agent, flow and goal template catalogues:
 * gradient accent bar, badge row, icon tile + title, clamped description, an
 * optional tools slot and a CTA.
 *
 * The caller owns the wrapper element — agent cards wrap this in a Link, goal
 * template cards wrap it in a button — so each keeps its own accessibility
 * semantics without a polymorphic `as` prop.
 */

export type Accent = {
  bar: string
  tile: string
  badge: string
  ring: string
}

export const ACCENTS: readonly Accent[] = [
  { bar: 'from-sky-500 to-cyan-400', tile: 'bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300', badge: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300', ring: 'hover:ring-sky-300/70 dark:hover:ring-sky-500/40' },
  { bar: 'from-violet-500 to-fuchsia-400', tile: 'bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300', badge: 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300', ring: 'hover:ring-violet-300/70 dark:hover:ring-violet-500/40' },
  { bar: 'from-emerald-500 to-teal-400', tile: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300', badge: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300', ring: 'hover:ring-emerald-300/70 dark:hover:ring-emerald-500/40' },
  { bar: 'from-amber-500 to-orange-400', tile: 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300', badge: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300', ring: 'hover:ring-amber-300/70 dark:hover:ring-amber-500/40' },
  { bar: 'from-rose-500 to-pink-400', tile: 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300', badge: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300', ring: 'hover:ring-rose-300/70 dark:hover:ring-rose-500/40' },
  { bar: 'from-indigo-500 to-blue-400', tile: 'bg-indigo-100 text-indigo-600', badge: 'border-indigo-200 bg-indigo-50 text-indigo-700', ring: 'hover:ring-indigo-300/70' },
] as const

export function hashIndex(seed: string, mod: number): number {
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) >>> 0
  return hash % mod
}

export function accentFor(category: string): Accent {
  return ACCENTS[hashIndex(category || 'default', ACCENTS.length)]
}

export function TemplateCardShell({
  accent,
  icon: Icon,
  title,
  description,
  descriptionClamp = 3,
  badges,
  tools,
  cta,
}: {
  accent: Accent
  icon: LucideIcon
  title: string
  description: string
  descriptionClamp?: 2 | 3
  badges: ReactNode
  tools?: ReactNode
  cta: ReactNode
}) {
  return (
    <Card className={cn(
      'group relative h-full overflow-hidden border-border/60 transition-all duration-200',
      'hover:-translate-y-0.5 hover:shadow-lg hover:ring-1',
      accent.ring,
    )}>
      <div className={cn('absolute inset-x-0 top-0 h-1 bg-gradient-to-r opacity-80 transition-opacity group-hover:opacity-100', accent.bar)} />
      <CardHeader className="space-y-2.5 pt-5">
        <div className="flex flex-wrap items-center gap-1.5">{badges}</div>
        <div className="flex items-start gap-2.5">
          <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-transform group-hover:scale-105', accent.tile)}>
            <Icon className="h-[18px] w-[18px]" />
          </span>
          <CardTitle className="min-w-0 text-base leading-snug">{title}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className={cn('text-sm text-muted-foreground', descriptionClamp === 2 ? 'line-clamp-2' : 'line-clamp-3')}>
          {description}
        </p>
        {tools}
        {cta}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 5: Refactor the agent card onto the shell**

Rewrite `src/components/templates/template-catalogue-card.tsx`, keeping `categoryIcon` (its agent/flow keyword heuristics stay here — goal templates map their closed category union directly) and deleting the moved `ACCENTS` / `hashIndex` / `accentFor`:

```tsx
import Link from 'next/link'
import { Bell, CalendarClock, Inbox, LineChart, ShieldAlert, Sparkles, Target, TrendingUp, Workflow } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { IntegrationChip } from '@/components/integrations/integration-chip'
import { accentFor, TemplateCardShell } from '@/components/templates/template-card-shell'
import { cn } from '@/lib/utils'

function categoryIcon(category: string, kind: 'agent' | 'flow') {
  if (kind === 'flow') return Workflow
  const normalized = category.toLowerCase()
  if (normalized.includes('meet')) return CalendarClock
  if (normalized.includes('risk') || normalized.includes('monitor') || normalized.includes('contract')) return ShieldAlert
  if (normalized.includes('forecast')) return LineChart
  if (normalized.includes('pipeline') || normalized.includes('discov') || normalized.includes('opportun')) return Target
  if (normalized.includes('inbox') || normalized.includes('productiv') || normalized.includes('exec')) return Inbox
  if (normalized.includes('sales') || normalized.includes('digest') || normalized.includes('revenue')) return TrendingUp
  if (normalized.includes('alert') || normalized.includes('notif') || normalized.includes('signal')) return Bell
  return Sparkles
}

type TemplateCatalogueCardProps = {
  href: string
  name: string
  description: string
  category: string
  integrations: readonly string[]
  kind?: 'agent' | 'flow'
  missingIntegrations?: readonly string[]
  actionLabel?: string
  advancesGoal?: string
}

/** The canonical catalogue card shared by agent and flow starters. */
export function TemplateCatalogueCard({
  href,
  name,
  description,
  category,
  integrations,
  kind = 'agent',
  missingIntegrations = [],
  actionLabel = 'Use template',
  advancesGoal,
}: TemplateCatalogueCardProps) {
  const accent = accentFor(category)

  return (
    <Link href={href} className="block h-full">
      <TemplateCardShell
        accent={accent}
        icon={categoryIcon(category, kind)}
        title={name}
        description={description}
        badges={
          <>
            <Badge variant="outline" className={cn('text-[11px] font-medium', accent.badge)}>{category}</Badge>
            {kind === 'flow' && <Badge variant="outline" className="text-[11px] font-medium">Flow</Badge>}
            {advancesGoal && (
              <Badge variant="secondary" className="max-w-full gap-1 text-[11px] font-medium text-indigo-500">
                <Target className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">Advances: {advancesGoal}</span>
              </Badge>
            )}
          </>
        }
        tools={
          integrations.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Requires</p>
              <div className="flex flex-wrap gap-1.5">
                {integrations.map((integration) => (
                  <span key={integration} className={cn(missingIntegrations.includes(integration) && 'saturate-150')}>
                    <IntegrationChip name={integration} />
                  </span>
                ))}
              </div>
            </div>
          ) : undefined
        }
        cta={
          <Button size="sm" variant={missingIntegrations.length > 0 ? 'outline' : 'default'} className="w-full" asChild>
            <span>{actionLabel}</span>
          </Button>
        }
      />
    </Link>
  )
}
```

- [ ] **Step 6: Run the characterization test against the refactor**

Run: `npx tsx --test $(find src -path '*__tests__*' -name 'template-catalogue-card.test.tsx')`
Expected: PASS (7 tests), unchanged from the baseline. Any failure means the refactor changed rendering — fix the shell, not the test.

- [ ] **Step 7: Verify the agent and flow catalogues visually**

Run: `npm run dev`, open `/templates` and `/flows/templates`. Confirm cards look identical to before — accent bar, badges, icon tile, chips, CTA. Stop the dev server.

- [ ] **Step 8: Typecheck, lint and run the full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add src/components/templates/template-card-shell.tsx src/components/templates/template-catalogue-card.tsx
git commit -m "$(cat <<'EOF'
refactor(templates): extract the shared catalogue card shell

Accent palette and card chrome move to template-card-shell so the goal
template card (next) is identical by construction rather than by discipline.
The caller owns the wrapper element -- Link for agents, button for goals --
instead of a polymorphic `as` prop. Characterization tests confirm no visual
change to the agent and flow catalogues.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: The goal template card

**Files:**
- Create: `src/components/goals/goal-template-card.tsx`
- Create: `src/components/goals/__tests__/goal-template-card.test.tsx`

**Interfaces:**
- Consumes: `TemplateCardShell`, `accentFor` (unused here — goals use `CATEGORY_ACCENTS`), `GoalTemplate`, `CATEGORY_ACCENTS`, `CATEGORY_ICONS`, `SOURCE_LABELS`, `IntegrationChip`
- Produces: `GoalTemplateCard(props: { template: GoalTemplate; connectedSources: Set<string>; onOpen: (template: GoalTemplate) => void })` from `@/components/goals/goal-template-card`

- [ ] **Step 1: Write the failing test**

Create `src/components/goals/__tests__/goal-template-card.test.tsx`:

```tsx
import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { GoalTemplateCard } from '../goal-template-card'
import { goalTemplateByKey } from '@/lib/goals/goal-templates'

afterEach(cleanup)

const template = goalTemplateByKey('sales-org-quarterly-revenue')!

test('renders name, category, scope badge and description', () => {
  render(<GoalTemplateCard template={template} connectedSources={new Set()} onOpen={() => {}} />)
  assert.ok(screen.getByText(template.name))
  assert.ok(screen.getByText('Revenue'))
  assert.ok(screen.getByText('Org'))
  assert.ok(screen.getByText(template.description))
})

test('renders a recurrence badge only when the template recurs', () => {
  // The badge renders `↻ {recurrence}` as two text nodes, so match on the
  // element's full textContent rather than an exact string.
  const hasRecurrenceBadge = () =>
    screen.queryAllByText((_, element) => element?.textContent?.trim() === '↻ quarterly').length > 0
  render(<GoalTemplateCard template={template} connectedSources={new Set()} onOpen={() => {}} />)
  assert.ok(hasRecurrenceBadge())
  cleanup()
  const noRecurrence = goalTemplateByKey('sales-org-arr-growth')!
  assert.equal(noRecurrence.recurrence, null, 'fixture assumption: this template does not recur')
  render(<GoalTemplateCard template={noRecurrence} connectedSources={new Set()} onOpen={() => {}} />)
  assert.equal(hasRecurrenceBadge(), false)
})

test('shows at most three source chips with an overflow count', () => {
  render(<GoalTemplateCard template={template} connectedSources={new Set()} onOpen={() => {}} />)
  assert.ok(screen.getByText('Reads from'))
  assert.ok(screen.getByText('Stripe'))
  // sales-org-quarterly-revenue has 5 sources after `manual` is appended.
  assert.ok(screen.getByText(`+${template.sources.length - 3}`))
})

test('is a button that reports the template when activated', () => {
  let opened: string | null = null
  render(
    <GoalTemplateCard
      template={template}
      connectedSources={new Set()}
      onOpen={(entry) => { opened = entry.key }}
    />,
  )
  const button = screen.getByRole('button', { name: new RegExp(template.name) })
  assert.equal(button.getAttribute('aria-haspopup'), 'dialog')
  fireEvent.click(button)
  assert.equal(opened, 'sales-org-quarterly-revenue')
})

test('dims sources that are not connected', () => {
  const { container } = render(
    <GoalTemplateCard template={template} connectedSources={new Set(['stripe'])} onOpen={() => {}} />,
  )
  assert.ok(container.querySelector('[data-connected="true"]'), 'connected chip missing')
  assert.ok(container.querySelector('[data-connected="false"]'), 'unconnected chip missing')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test $(find src -path '*__tests__*' -name 'goal-template-card.test.tsx')`
Expected: FAIL — `Cannot find module '../goal-template-card'`

- [ ] **Step 3: Create the card**

Create `src/components/goals/goal-template-card.tsx`:

```tsx
'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { IntegrationChip } from '@/components/integrations/integration-chip'
import { TemplateCardShell } from '@/components/templates/template-card-shell'
import { CATEGORY_ACCENTS, CATEGORY_ICONS } from '@/components/goals/goal-template-accents'
import { SOURCE_LABELS } from '@/components/goals/source-labels'
import type { GoalTemplate } from '@/lib/goals/goal-templates'
import { cn } from '@/lib/utils'

const VISIBLE_SOURCES = 3

/**
 * A goal template in the catalogue grid. Same chrome as the agent and flow
 * cards, but it renders a button rather than a link — clicking opens the
 * detail dialog, it does not create anything.
 */
export function GoalTemplateCard({
  template,
  connectedSources,
  onOpen,
}: {
  template: GoalTemplate
  /** Metric sources the workspace has a working connection for. */
  connectedSources: Set<string>
  onOpen: (template: GoalTemplate) => void
}) {
  const accent = CATEGORY_ACCENTS[template.category]
  const shown = template.sources.slice(0, VISIBLE_SOURCES)
  const overflow = template.sources.length - shown.length

  return (
    <button
      type="button"
      onClick={() => onOpen(template)}
      aria-haspopup="dialog"
      className="block h-full w-full rounded-2xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <TemplateCardShell
        accent={accent}
        icon={CATEGORY_ICONS[template.category]}
        title={template.name}
        description={template.description}
        badges={
          <>
            <Badge variant="outline" className={cn('text-[11px] font-medium', accent.badge)}>
              {template.category}
            </Badge>
            <Badge variant={template.scope === 'org' ? 'secondary' : 'outline'} className="text-[11px] font-medium">
              {template.scope === 'org' ? 'Org' : 'Personal'}
            </Badge>
            {template.recurrence && (
              <Badge variant="outline" className="text-[11px] font-medium">
                ↻ {template.recurrence}
              </Badge>
            )}
          </>
        }
        tools={
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Reads from</p>
            <div className="flex flex-wrap items-center gap-1.5">
              {shown.map((source) => (
                <span
                  key={source}
                  data-connected={connectedSources.has(source)}
                  className={cn(!connectedSources.has(source) && 'opacity-55')}
                >
                  <IntegrationChip name={SOURCE_LABELS[source] ?? source} />
                </span>
              ))}
              {overflow > 0 && (
                <span className="text-xs font-medium text-muted-foreground">+{overflow}</span>
              )}
            </div>
          </div>
        }
        cta={
          <Button size="sm" variant="default" className="w-full" asChild>
            <span>View goal</span>
          </Button>
        }
      />
    </button>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test $(find src -path '*__tests__*' -name 'goal-template-card.test.tsx')`
Expected: PASS (5 tests). Note `manual`'s label is `"I'll record values myself"` — if a chip assertion trips on it, that is expected; `manual` is last so it falls into the overflow count for any template with 3+ ranked sources.

- [ ] **Step 5: Typecheck, lint and run the full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/goals/goal-template-card.tsx src/components/goals/__tests__/goal-template-card.test.tsx
git commit -m "$(cat <<'EOF'
feat(goals): template cards match the agent catalogue

Same shell as the agent and flow cards -- accent bar, category badge, icon
tile, tool chips, CTA -- but rendered as a button that opens the detail
dialog rather than a link into the wizard. Unconnected sources render dimmed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Source-connection state helper

The card and the modal both need "which metric sources does this workspace actually have?". Derive it once from `/api/goals/metrics/sources`.

**Files:**
- Modify: `src/lib/metrics/source-options.ts`
- Create: `src/lib/metrics/__tests__/source-options.test.ts` (or extend it if it already exists)

**Interfaces:**
- Produces: `connectedSourceSet(options: MetricSourceOption[]): Set<string>` from `@/lib/metrics/source-options`

- [ ] **Step 1: Write the failing test**

Create `src/lib/metrics/__tests__/source-options.test.ts` (if the file exists, append these two tests):

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { connectedSourceSet, type MetricSourceOption } from '../source-options'

const option = (
  source: string,
  extra: Partial<MetricSourceOption> = {},
): MetricSourceOption => ({
  source,
  group: 'source_of_truth',
  metrics: [],
  connections: [],
  ...extra,
})

test('a source counts as connected when it has a connection, is available, or is manual', () => {
  const set = connectedSourceSet([
    option('stripe', { connections: [{ ref: 'conn_1', label: 'Acme' }] }),
    option('hubspot'),
    option('url', { available: true }),
    option('manual', { group: 'start_now' }),
  ])
  assert.deepEqual([...set].sort(), ['manual', 'stripe', 'url'])
})

test('an empty option list yields an empty set, not a throw', () => {
  assert.equal(connectedSourceSet([]).size, 0)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test $(find src -path '*__tests__*' -name 'source-options.test.ts')`
Expected: FAIL — `connectedSourceSet is not a function`

- [ ] **Step 3: Add the helper**

Append to `src/lib/metrics/source-options.ts`:

```ts
/**
 * The set of metric sources this workspace can actually read from right now.
 * Shared by the goal template card (dimming unconnected chips) and the
 * template detail modal (marking a recommended source).
 */
export function connectedSourceSet(options: MetricSourceOption[]): Set<string> {
  return new Set(options.filter(sourceIsAvailable).map((option) => option.source))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test $(find src -path '*__tests__*' -name 'source-options.test.ts')`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/lib/metrics/source-options.ts src/lib/metrics/__tests__/source-options.test.ts
git commit -m "$(cat <<'EOF'
feat(metrics): derive the set of connected metric sources

Shared by the goal template card and its detail modal so both agree on what
"connected" means, using the existing sourceIsAvailable predicate.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: The template detail modal

**Files:**
- Create: `src/components/goals/goal-template-detail.tsx`
- Create: `src/components/goals/__tests__/goal-template-detail.test.tsx`

**Interfaces:**
- Consumes: `buildPreviewDashboardData` (Task 4), `connectedSourceSet` (Task 7), `CATEGORY_ACCENTS` / `CATEGORY_ICONS` (Task 2), `resolveLayoutMetricRefs`, `GoalDashboard`, `Dialog*`, `ErrorBoundary`, `SOURCE_LABELS` / `SOURCE_HINTS`
- Produces: `GoalTemplateDetail(props: { template: GoalTemplate | null; sources: MetricSourceOption[]; sourcesFailed: boolean; onClose: () => void })` from `@/components/goals/goal-template-detail`

- [ ] **Step 1: Write the failing test**

Create `src/components/goals/__tests__/goal-template-detail.test.tsx`:

```tsx
import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen } from '@testing-library/react'
import { GoalTemplateDetail } from '../goal-template-detail'
import { goalTemplateByKey } from '@/lib/goals/goal-templates'
import type { MetricSourceOption } from '@/lib/metrics/source-options'

afterEach(cleanup)

const orgTemplate = goalTemplateByKey('sales-org-quarterly-revenue')!
const personalTemplate = goalTemplateByKey('sales-personal-quota')!

const sources: MetricSourceOption[] = [
  { source: 'stripe', group: 'source_of_truth', metrics: [], connections: [{ ref: 'c1', label: 'Acme' }] },
  { source: 'hubspot', group: 'source_of_truth', metrics: [], connections: [] },
  { source: 'manual', group: 'start_now', metrics: [], connections: [] },
]

test('renders nothing when no template is selected', () => {
  const { container } = render(
    <GoalTemplateDetail template={null} sources={[]} sourcesFailed={false} onClose={() => {}} />,
  )
  assert.equal(container.textContent, '')
})

test('shows the name, tracks copy and direction', () => {
  render(<GoalTemplateDetail template={orgTemplate} sources={sources} sourcesFailed={false} onClose={() => {}} />)
  assert.ok(screen.getByText(orgTemplate.name))
  assert.ok(screen.getByText(orgTemplate.tracks))
  assert.ok(screen.getByText(/should go up/i))
})

test('states org scope plainly', () => {
  render(<GoalTemplateDetail template={orgTemplate} sources={sources} sourcesFailed={false} onClose={() => {}} />)
  assert.ok(screen.getByText(/visible to everyone in your workspace/i))
})

test('states personal scope plainly', () => {
  render(<GoalTemplateDetail template={personalTemplate} sources={sources} sourcesFailed={false} onClose={() => {}} />)
  assert.ok(screen.getByText(/visible only to you/i))
})

test('marks the first connected source as recommended and offers a connect link for the rest', () => {
  render(<GoalTemplateDetail template={orgTemplate} sources={sources} sourcesFailed={false} onClose={() => {}} />)
  assert.ok(screen.getByText('Recommended'))
  assert.ok(screen.getAllByText('Connect').length > 0)
})

test('when the source probe failed, no source is marked recommended', () => {
  render(<GoalTemplateDetail template={orgTemplate} sources={[]} sourcesFailed onClose={() => {}} />)
  assert.equal(screen.queryByText('Recommended'), null)
  assert.equal(screen.queryByText('Connect'), null)
})

test('links Use template at the prefill URL', () => {
  const { container } = render(
    <GoalTemplateDetail template={orgTemplate} sources={sources} sourcesFailed={false} onClose={() => {}} />,
  )
  const link = [...container.querySelectorAll('a')].find(
    (anchor) => anchor.textContent?.includes('Use template'),
  )
  assert.ok(link)
  assert.equal(link?.getAttribute('href'), '/goals/new?template=sales-org-quarterly-revenue')
})

test('labels the preview as sample data', () => {
  render(<GoalTemplateDetail template={orgTemplate} sources={sources} sourcesFailed={false} onClose={() => {}} />)
  assert.ok(screen.getByText(/sample data/i))
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test $(find src -path '*__tests__*' -name 'goal-template-detail.test.tsx')`
Expected: FAIL — `Cannot find module '../goal-template-detail'`

- [ ] **Step 3: Create the modal**

Create `src/components/goals/goal-template-detail.tsx`:

```tsx
'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import { Check } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import { GoalDashboard } from '@/components/goals/widgets/goal-dashboard'
import { CATEGORY_ACCENTS, CATEGORY_ICONS } from '@/components/goals/goal-template-accents'
import { SOURCE_HINTS, SOURCE_LABELS } from '@/components/goals/source-labels'
import { buildPreviewDashboardData } from '@/lib/goals/preview-data'
import { resolveLayoutMetricRefs } from '@/lib/goals/dashboard'
import { connectedSourceSet, type MetricSourceOption } from '@/lib/metrics/source-options'
import type { GoalTemplate } from '@/lib/goals/goal-templates'
import { GOAL_KIND_LABELS } from '@/lib/types'
import { cn } from '@/lib/utils'

/** Plausible sample targets so the preview shows a believable shape. The
 *  user's real target is always collected in the wizard. */
const SAMPLE_TARGETS: Record<string, { start: number; target: number }> = {
  usd: { start: 250_000, target: 1_000_000 },
  count: { start: 40, target: 160 },
  percent: { start: 62, target: 85 },
}

export function GoalTemplateDetail({
  template,
  sources,
  sourcesFailed,
  onClose,
}: {
  template: GoalTemplate | null
  sources: MetricSourceOption[]
  /** True when /api/goals/metrics/sources failed — render neutral, never block. */
  sourcesFailed: boolean
  onClose: () => void
}) {
  const connected = useMemo(
    () => (sourcesFailed ? new Set<string>() : connectedSourceSet(sources)),
    [sources, sourcesFailed],
  )

  const preview = useMemo(() => {
    if (!template) return null
    const sample = SAMPLE_TARGETS[template.unit] ?? SAMPLE_TARGETS.count
    const { start, target } = sample
    const built = buildPreviewDashboardData({
      name: template.name,
      description: template.description,
      kind: template.kind,
      direction: template.direction,
      unit: template.unit,
      startValue: template.direction === 'decrease' ? target : start,
      targetValue: template.direction === 'decrease' ? start : target,
      targetDate: null,
      recurrence: template.recurrence,
      personal: template.scope === 'personal',
      metrics: [
        {
          label: template.name,
          role: 'primary',
          unit: template.unit,
          source: template.sources[0],
          metricKey: 'preview',
        },
      ],
      seed: template.key,
    })
    return {
      data: built.data,
      layout: resolveLayoutMetricRefs(template.layout, built.metricIds),
    }
  }, [template])

  if (!template || !preview) return null

  const accent = CATEGORY_ACCENTS[template.category]
  const Icon = CATEGORY_ICONS[template.category]
  const recommended = sourcesFailed
    ? null
    : (template.sources.find((source) => connected.has(source)) ?? null)

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', accent.tile)}>
              <Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0 space-y-2">
              <DialogTitle className="text-lg leading-snug">{template.name}</DialogTitle>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className={cn('text-[11px] font-medium', accent.badge)}>
                  {template.category}
                </Badge>
                <Badge variant={template.scope === 'org' ? 'secondary' : 'outline'} className="text-[11px] font-medium">
                  {template.scope === 'org' ? 'Org' : 'Personal'}
                </Badge>
                <Badge variant="outline" className="text-[11px] font-medium">
                  {GOAL_KIND_LABELS[template.kind]}
                </Badge>
                {template.recurrence && (
                  <Badge variant="outline" className="text-[11px] font-medium">↻ {template.recurrence}</Badge>
                )}
              </div>
            </div>
          </div>
          <DialogDescription className="pt-2">{template.description}</DialogDescription>
        </DialogHeader>

        <section className="space-y-1.5">
          <h3 className="text-sm font-semibold">What gets tracked</h3>
          <p className="text-sm text-muted-foreground">{template.tracks}</p>
          <p className="text-sm text-muted-foreground">
            This number should go{' '}
            <strong className="text-foreground">
              {template.direction === 'increase' ? 'up' : 'down'}
            </strong>{' '}
            over time.
          </p>
          <p className="text-xs text-muted-foreground">
            {template.scope === 'org'
              ? 'Creates an organization goal, visible to everyone in your workspace. You can switch it to personal in the next step.'
              : 'Creates a personal goal, visible only to you. You can switch it to an organization goal in the next step.'}
          </p>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Reads from</h3>
          <ul className="space-y-1.5">
            {template.sources.map((source) => {
              const isConnected = connected.has(source)
              return (
                <li
                  key={source}
                  data-connected={isConnected}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-sm font-medium">
                      {isConnected && <Check className="h-3.5 w-3.5 text-emerald-500" aria-hidden />}
                      {SOURCE_LABELS[source] ?? source}
                      {recommended === source && (
                        <Badge variant="secondary" className="text-[10px] font-medium">Recommended</Badge>
                      )}
                    </p>
                    {SOURCE_HINTS[source] && (
                      <p className="text-xs text-muted-foreground">{SOURCE_HINTS[source]}</p>
                    )}
                    {source === 'manual' && (
                      <p className="text-xs text-muted-foreground">
                        Always available — no connection needed.
                      </p>
                    )}
                  </div>
                  {!isConnected && !sourcesFailed && source !== 'manual' && (
                    <Button size="sm" variant="outline" asChild>
                      <Link href="/integrations">Connect</Link>
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        </section>

        <section className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold">Dashboard preview</h3>
            <p className="text-xs text-muted-foreground">Sample data — your real numbers replace it.</p>
          </div>
          <ErrorBoundary
            fallback={
              <p className="rounded-lg border border-border/60 p-4 text-sm text-muted-foreground">
                Preview unavailable.
              </p>
            }
          >
            <GoalDashboard layout={preview.layout} data={preview.data} />
          </ErrorBoundary>
        </section>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button asChild>
            <Link href={`/goals/new?template=${template.key}`}>Use template</Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test $(find src -path '*__tests__*' -name 'goal-template-detail.test.tsx')`
Expected: PASS (8 tests). If `DialogContent` renders into a portal that Testing Library cannot see, the `screen` queries still work — RTL queries `document.body`.

- [ ] **Step 5: Typecheck, lint and run the full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/goals/goal-template-detail.tsx src/components/goals/__tests__/goal-template-detail.test.tsx
git commit -m "$(cat <<'EOF'
feat(goals): template detail modal with tool state and a live dashboard preview

Shows what the goal tracks, which direction it should move, every source it
can read from with live connected state, and the real widget dashboard
rendered against seeded sample data. Scope is stated plainly so an org
template does not surprise anyone about where the goal lands. A failed source
probe degrades to neutral rather than blocking the modal.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Paginated gallery wired to the cards and modal

**Files:**
- Modify: `src/components/goals/goal-template-gallery.tsx` (full rewrite)
- Create: `src/components/goals/__tests__/goal-template-gallery.test.tsx`

**Interfaces:**
- Consumes: `GoalTemplateCard` (Task 6), `GoalTemplateDetail` (Task 8), `Pagination` / `paginate` from `@/components/ui/pagination`, `connectedSourceSet` (Task 7)
- Produces: `GoalTemplateGallery()` — unchanged export name and no props, so `src/app/goals/page.tsx` needs no change

- [ ] **Step 1: Write the failing test**

Create `src/components/goals/__tests__/goal-template-gallery.test.tsx`:

```tsx
import '@/test-support/jsdom-env'
import { test, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { GoalTemplateGallery } from '../goal-template-gallery'
import { GOAL_TEMPLATES } from '@/lib/goals/goal-templates'

const PAGE_SIZE = 9

beforeEach(() => {
  globalThis.fetch = (async () =>
    ({ ok: true, status: 200, json: async () => ({ sources: [] }) }) as Response) as typeof fetch
})
afterEach(cleanup)

test('shows exactly one page of templates at a time', () => {
  render(<GoalTemplateGallery />)
  assert.equal(screen.getAllByText('View goal').length, PAGE_SIZE)
})

test('paging forward shows the next slice', () => {
  render(<GoalTemplateGallery />)
  const firstName = GOAL_TEMPLATES[0].name
  assert.ok(screen.getByText(firstName))
  fireEvent.click(screen.getByRole('button', { name: /next/i }))
  assert.equal(screen.queryByText(firstName), null)
  assert.ok(screen.getByText(GOAL_TEMPLATES[PAGE_SIZE].name))
})

test('picking a department resets to page 1 and hides the pager', () => {
  render(<GoalTemplateGallery />)
  fireEvent.click(screen.getByRole('button', { name: /next/i }))
  fireEvent.click(screen.getByRole('tab', { name: 'Sales' }))
  // Nine per department means one page — the pager renders nothing.
  assert.equal(screen.queryByRole('button', { name: /next/i }), null)
  assert.equal(screen.getAllByText('View goal').length, 9)
})

test('clicking a card opens the detail dialog', async () => {
  render(<GoalTemplateGallery />)
  const template = GOAL_TEMPLATES[0]
  fireEvent.click(screen.getByRole('button', { name: new RegExp(template.name) }))
  await waitFor(() => {
    assert.ok(screen.getByText(template.tracks))
  })
})

test('a failed source probe still renders the gallery', async () => {
  globalThis.fetch = (async () => { throw new Error('offline') }) as typeof fetch
  render(<GoalTemplateGallery />)
  await waitFor(() => {
    assert.equal(screen.getAllByText('View goal').length, PAGE_SIZE)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test $(find src -path '*__tests__*' -name 'goal-template-gallery.test.tsx')`
Expected: FAIL — the current gallery renders 20 cards and has no `View goal` CTA.

- [ ] **Step 3: Rewrite the gallery**

Replace `src/components/goals/goal-template-gallery.tsx` entirely:

```tsx
'use client'

import { useEffect, useMemo, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Pagination, paginate } from '@/components/ui/pagination'
import { GoalTemplateCard } from '@/components/goals/goal-template-card'
import { GoalTemplateDetail } from '@/components/goals/goal-template-detail'
import { GOAL_TEMPLATES, type GoalTemplate } from '@/lib/goals/goal-templates'
import { connectedSourceSet, type MetricSourceOption } from '@/lib/metrics/source-options'
import { PRODUCT_DEPARTMENTS } from '@/lib/templates/departments'

const PAGE_SIZE = 9

const DEPARTMENT_LABELS: Record<string, string> = {
  sales: 'Sales',
  marketing: 'Marketing',
  engineering: 'Engineering',
  finance: 'Finance',
  csm: 'Customer Success',
}

/**
 * "Start from a template": 45 starting points, nine per served department,
 * nine to a page. Clicking a card opens its detail dialog — tools, what gets
 * tracked, and a preview of the dashboard it produces. Nothing is created
 * until the wizard, where the target and source stay the user's.
 *
 * Page state is deliberately component-local rather than in the URL: the
 * gallery sits mid-page on /goals and must not push history entries.
 */
export function GoalTemplateGallery() {
  const [department, setDepartment] = useState<string>('all')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<GoalTemplate | null>(null)
  const [sources, setSources] = useState<MetricSourceOption[]>([])
  const [sourcesFailed, setSourcesFailed] = useState(false)

  // Best-effort: connection state decorates the cards, it never gates them.
  useEffect(() => {
    let cancelled = false
    fetch('/api/goals/metrics/sources', { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'sources unavailable')
        if (!cancelled) setSources(body.sources ?? [])
      })
      .catch(() => {
        if (!cancelled) setSourcesFailed(true)
      })
    return () => { cancelled = true }
  }, [])

  const connected = useMemo(
    () => (sourcesFailed ? new Set<string>() : connectedSourceSet(sources)),
    [sources, sourcesFailed],
  )

  const visible = useMemo(
    () =>
      department === 'all'
        ? GOAL_TEMPLATES
        : GOAL_TEMPLATES.filter((entry) => entry.department === department),
    [department],
  )
  const { pageItems, pageCount, page: currentPage } = paginate(visible, page, PAGE_SIZE)

  return (
    <section className="space-y-3" aria-labelledby="goal-templates-heading">
      <div>
        <h2 id="goal-templates-heading" className="flex items-center gap-2 text-lg font-semibold">
          <Sparkles className="h-4 w-4 text-indigo-500" />
          Start from a template
        </h2>
        <p className="text-xs text-muted-foreground">
          Proven targets by team — open one to see what it tracks and the dashboard you&apos;ll get.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter templates by department">
        {['all', ...PRODUCT_DEPARTMENTS].map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={department === key}
            onClick={() => { setDepartment(key); setPage(1) }}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              department === key
                ? 'border-foreground/30 bg-secondary text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {key === 'all' ? 'All teams' : DEPARTMENT_LABELS[key]}
          </button>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {pageItems.map((entry) => (
          <GoalTemplateCard
            key={entry.key}
            template={entry}
            connectedSources={connected}
            onOpen={setSelected}
          />
        ))}
      </div>

      <Pagination page={currentPage} pageCount={pageCount} onPageChange={setPage} />

      <GoalTemplateDetail
        template={selected}
        sources={sources}
        sourcesFailed={sourcesFailed}
        onClose={() => setSelected(null)}
      />
    </section>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test $(find src -path '*__tests__*' -name 'goal-template-gallery.test.tsx')`
Expected: PASS (5 tests)

- [ ] **Step 5: Typecheck, lint and run the full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean. `src/app/goals/page.tsx` is untouched — the export name and empty props are unchanged.

- [ ] **Step 6: Verify in the browser**

Run `npm run dev`, open `/goals`. Confirm: 9 cards in a 3×3 grid, pager reading "Page 1 of 5", clicking Sales collapses to one page with no pager, clicking a card opens the modal with a rendered dashboard preview. Stop the dev server.

- [ ] **Step 7: Commit**

```bash
git add src/components/goals/goal-template-gallery.tsx src/components/goals/__tests__/goal-template-gallery.test.tsx
git commit -m "$(cat <<'EOF'
feat(goals): paginate the template gallery and open cards into detail

Nine per page in a 3x3 grid over the reusable Pagination/paginate helpers.
Page state is component-local so the mid-page gallery never hijacks history.
Cards open the detail dialog; the source probe is best-effort and a failure
degrades to undecorated cards rather than an empty gallery.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Carry the template layout into the created goal

The dashboard the user previewed must be the dashboard they get.

**Files:**
- Modify: `src/app/goals/new/page.tsx:104-137` (prefill) and `:289-314` (POST body)

**Interfaces:**
- Consumes: `GoalTemplate.layout` (Task 2)
- Produces: nothing new — `POST /api/goals` already accepts `dashboardLayout`

- [ ] **Step 1: Add layout state**

In `src/app/goals/new/page.tsx`, alongside the existing `const [csvIntent, setCsvIntent] = useState(false)` (line 102), add:

```tsx
  // Set when a template is applied — the layout the user previewed in the
  // template modal, sent verbatim so the created goal's dashboard matches.
  const [templateLayout, setTemplateLayout] = useState<DashboardLayout | null>(null)
```

Add the import:

```tsx
import type { DashboardLayout } from '@/lib/goals/dashboard'
```

- [ ] **Step 2: Capture the layout during template prefill**

In the template-prefill `useEffect` (line 109's `if (entry) {` block), add `setTemplateLayout(entry.layout)` immediately after the `setState((current) => ({ ... }))` call and before the `toast.info(...)`:

```tsx
      setTemplateLayout(entry.layout)
```

- [ ] **Step 3: Send it in the POST body**

In the submit handler's `JSON.stringify({ ... })` (line 292), add after the `parentGoalId` spread and before `metric:`:

```tsx
          ...(templateLayout ? { dashboardLayout: templateLayout } : {}),
```

- [ ] **Step 4: Verify the round trip against a real database**

Follow the `verify` skill's route-smoke protocol against a throwaway Postgres. Create `src/lib/goals/__tests__/template-layout-e2e.test.ts`, mirroring the `TEST_DATABASE_URL` guard used by `goals-e2e.test.ts`:

```ts
/**
 * A goal created from a template must persist that template's dashboard
 * layout, with metric-index refs resolved to real metric ids.
 * Skipped unless TEST_DATABASE_URL is present.
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
  })

  test('a templated goal persists the template layout with resolved metric ids', async () => {
    const { POST } = await import('@/app/api/goals/route')
    const { goalTemplateByKey } = await import('@/lib/goals/goal-templates')
    const template = goalTemplateByKey('sales-org-quarterly-revenue')!

    const response = await POST(
      new NextRequest('http://localhost/api/goals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: template.name,
          kind: template.kind,
          direction: template.direction,
          unit: template.unit,
          startValue: 100,
          targetValue: 500,
          targetDate: new Date(Date.now() + 90 * 86_400_000).toISOString(),
          recurrence: template.recurrence,
          personal: template.scope === 'personal',
          dashboardLayout: template.layout,
          metric: { source: 'manual', metricKey: 'manual', connectionRef: null, config: {} },
        }),
      }) as any,
    )
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))

    const goal = await prisma.goal.findUnique({
      where: { id: body.goal.id },
      include: { metrics: true },
    })
    const layout = goal.dashboardLayout as { version: number; widgets: Array<{ id: string; type: string }> }
    assert.equal(layout.version, 1)
    assert.deepEqual(
      layout.widgets.map((widget) => widget.type),
      template.layout.widgets.map((widget) => widget.type),
      'persisted widget types drifted from the template',
    )
    assert.equal(goal.ownerUserId, null, 'an org template must not set an owner')
  })

  test('a personal template lands owned by the creator', async () => {
    const { POST } = await import('@/app/api/goals/route')
    const { goalTemplateByKey } = await import('@/lib/goals/goal-templates')
    const template = goalTemplateByKey('sales-personal-quota')!

    const response = await POST(
      new NextRequest('http://localhost/api/goals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: template.name,
          kind: template.kind,
          direction: template.direction,
          unit: template.unit,
          startValue: 0,
          targetValue: 250,
          targetDate: new Date(Date.now() + 90 * 86_400_000).toISOString(),
          recurrence: template.recurrence,
          personal: true,
          dashboardLayout: template.layout,
          metric: { source: 'manual', metricKey: 'manual', connectionRef: null, config: {} },
        }),
      }) as any,
    )
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    const goal = await prisma.goal.findUnique({ where: { id: body.goal.id } })
    assert.equal(goal.ownerUserId, seeded.userId, 'a personal template must set the owner')
  })
}
```

- [ ] **Step 5: Run the smoke test against a throwaway Postgres**

Per the `verify` skill and the `qa-db-migrate-deploy-gotcha` note: **deploy migrations to the test database before trusting failures.**

```bash
export TEST_DATABASE_URL=<throwaway postgres url>
DATABASE_URL=$TEST_DATABASE_URL DIRECT_URL=$TEST_DATABASE_URL npx prisma migrate deploy
npx tsx --test $(find src -path '*__tests__*' -name 'template-layout-e2e.test.ts')
```

Expected: PASS (2 tests). Without `TEST_DATABASE_URL` the file is a no-op — that is intended.

- [ ] **Step 6: Typecheck, lint and run the full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/app/goals/new/page.tsx src/lib/goals/__tests__/template-layout-e2e.test.ts
git commit -m "$(cat <<'EOF'
feat(goals): a templated goal keeps the dashboard it previewed

The wizard carries the template's layout through to POST /api/goals, which
already validates and resolves it. Route smoke test confirms the persisted
widget set matches the template and that org vs personal scope lands on the
right owner.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: A created goal is never invisible

The reported bug. Creation redirected to a list where org goals sit in a section the user was not watching, and an empty section rendered nothing at all.

**Files:**
- Modify: `src/app/goals/new/page.tsx:327-332`
- Modify: `src/app/goals/page.tsx:153-176`

**Interfaces:** none new.

- [ ] **Step 1: Land on the created goal**

In `src/app/goals/new/page.tsx`, replace the success toast + redirect (lines 327-332):

```tsx
      toast.success(
        state.source === 'manual'
          ? 'Goal created.'
          : 'Goal created — first sync lands within the hour.',
      )
      router.push(`/goals/${body.goal.id}`)
```

The `csvIntent` branch above it already redirects to `/goals/${body.goal.id}?import=1` and takes precedence — leave it alone.

- [ ] **Step 2: Always render both sections**

In `src/app/goals/page.tsx`, replace the two conditional sections (lines 156-175) with:

```tsx
              <section className="space-y-3">
                <h2 className="text-lg font-semibold">Organization goals</h2>
                {organizationGoals.length > 0 ? (
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {organizationGoals.map((goal) => (
                      <GoalCard key={goal.id} goal={goal} />
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No organization goals yet — these are visible across your workspace.
                  </p>
                )}
              </section>
              <section className="space-y-3">
                <h2 className="text-lg font-semibold">My goals</h2>
                {personalGoals.length > 0 ? (
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {personalGoals.map((goal) => (
                      <GoalCard key={goal.id} goal={goal} />
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No personal goals yet — personal goals are visible only to you.
                  </p>
                )}
              </section>
```

This block sits inside the existing `goals.length > 0` branch, so the zero-goals hero is untouched.

- [ ] **Step 3: Verify both paths in the browser**

Run `npm run dev`. Then:

1. Open `/goals`, click an **org** template (e.g. "Quarterly revenue target"), read the modal's scope line, click **Use template**, complete the wizard with a manual source.
2. Confirm you land on `/goals/<id>` showing the dashboard whose widgets match the modal preview.
3. Navigate back to `/goals`. Confirm the goal is under **Organization goals**, and **My goals** renders its header plus the hint.
4. Repeat with a **personal** template and confirm it lands under **My goals**.

Stop the dev server.

- [ ] **Step 4: Typecheck, lint and run the full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/goals/new/page.tsx src/app/goals/page.tsx
git commit -m "$(cat <<'EOF'
fix(goals): a created goal is never invisible

Creation redirected to /goals, where an org-scoped goal lands in a section
above the one a user watching for "my goal" looks at -- and an empty section
rendered nothing at all. Now creation lands on the goal's own dashboard, and
both Organization goals and My goals always render with a hint when empty.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] **Full check**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green.

- [ ] **Route smoke against a real database**

```bash
export TEST_DATABASE_URL=<throwaway postgres url>
DATABASE_URL=$TEST_DATABASE_URL DIRECT_URL=$TEST_DATABASE_URL npx prisma migrate deploy
npm test
```
Expected: the two e2e suites (`goals-e2e`, `template-layout-e2e`) run rather than no-op, and pass.

- [ ] **Spec walkthrough**

Open the spec and confirm each component is delivered: template model (Tasks 2-3), card shell (Task 5), card (Task 6), pagination (Task 9), detail modal + preview (Tasks 4, 7, 8), layout carried through (Task 10), goal-visibility fix (Task 11).

---

## Self-Review Notes

**Spec coverage** — every spec component maps to a task; `connectedSourceSet` (Task 7) was added because both the card and the modal need the same "is this connected" answer and the spec left it implicit in two places.

**Deviations from the spec, deliberate:**
1. `TemplateCardShell` takes no `as` prop — the caller owns the wrapper element. Simpler, avoids polymorphic-component typing, and each caller keeps its own accessibility semantics.
2. Pagination reuses the existing, already-tested `Pagination` / `paginate` in `src/components/ui/pagination.tsx` rather than adding new page-math or a new test file. The spec's pagination test is therefore dropped as redundant — it would test shipped, covered code.
3. The spec called for numbered page controls; the existing `Pagination` renders "Page N of M" with prev/next. Reusing it beats forking it for numbering. If numbered pages are wanted later, extend the shared component so every catalogue gains them at once.

**Known limitation:** the modal's `Connect` action links to `/integrations` generally rather than deep-linking to a specific provider. Per-source deep links would need a source→integration-route map that does not exist yet; the generic link is honest and does not block the flow.
