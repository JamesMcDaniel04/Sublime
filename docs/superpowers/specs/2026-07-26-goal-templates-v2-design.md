# Goal Templates v2 — catalogue cards, detail modal, per-template dashboards

**Date:** 2026-07-26
**Status:** Approved design, ready for planning
**Touches:** `src/lib/goals/goal-templates.ts`, `src/components/goals/`, `src/components/templates/`, `src/app/goals/`

## Problem

The goal-template gallery is the weakest surface in the Goals feature.

- **Cards are bare.** [`goal-template-gallery.tsx`](../../../src/components/goals/goal-template-gallery.tsx) renders a flat 4-column grid of name + badge + 2-line description. The agent/flow catalogue card ([`template-catalogue-card.tsx`](../../../src/components/templates/template-catalogue-card.tsx)) is far richer — accent bar, category badge, icon tile, required-integration chips, CTA — and the two catalogues should not look like they came from different products.
- **No detail step.** Clicking a card jumps straight into the 3-step wizard. There is nowhere to learn what the goal actually tracks, or which tools have to be connected to track it.
- **Tools are invisible.** Templates carry no source metadata. A user cannot tell whether a template is usable on their stack until wizard step 2.
- **No dashboard identity.** Templates carry no `dashboardLayout`, so every templated goal falls back to `defaultLayoutForGoal()`. Two very different goals produce identical dashboards.
- **20 templates in one unbroken grid** with no pagination.
- **Created goals appear to vanish.** Ten of the twenty templates are `scope: 'org'`, which the wizard maps to `personal: false` and the API stores as `ownerUserId: null`. The goal renders under **Organization goals** — a section above **My goals** that a user watching for "my goal" does not look at. Compounding it, [`goals/page.tsx`](../../../src/app/goals/page.tsx) hides an empty section entirely, and creation redirects to `/goals` rather than to the new goal. Nothing is lost; the goal is simply not where the user is looking.

## Non-goals

- No standalone exportable `.html` artifact. "HTML dashboard" means the rendered in-app widget dashboard.
- No LLM-generated layouts at template-selection time. Layouts are hand-authored and deterministic. The Copilot path already covers AI-drafted layouts for freeform goals.
- No new departments. `PRODUCT_DEPARTMENTS` is shared infrastructure (see below).
- No multi-metric templates. See "Single-metric constraint".
- No schema migration. `Goal.dashboardLayout` already exists and `POST /api/goals` already accepts `dashboardLayout`.

## Two constraints that shape everything

### `PRODUCT_DEPARTMENTS` is shared infrastructure

[`departments.ts`](../../../src/lib/templates/departments.ts) defines the `Department` union used by the agent seed catalogue, relevance sorting, and BI auto-tagging in `template-from-run.ts`. Adding Support / Ops / Product / HR would ripple through all of them.

**Therefore the catalogue grows by depth, not width:** 5 departments × 9 templates = 45. This also makes a department filter resolve to exactly one page of 9.

### Single-metric constraint

Of the 12 widget types in [`dashboard.ts`](../../../src/lib/goals/dashboard.ts), only `comparison` and `ratio` require 2+ metrics. The other ten — `kpi`, `trend`, `progress`, `narrative`, `impact`, `benchmark`, `periods`, `contributions`, `history`, `rollups` — read the primary metric or no metric at all.

The wizard binds exactly one metric. **Therefore template layouts use only the ten single-metric widget types**, and templates gain bespoke dashboards with zero changes to the wizard's metric-binding UI. This is enforced by test, not convention.

---

## Component 1 — The template model

### Interface

`GoalTemplate` in [`goal-templates.ts`](../../../src/lib/goals/goal-templates.ts) gains four fields:

```ts
export type GoalTemplate = {
  // ...existing: key, department, scope, name, description, kind,
  //              direction, unit, recurrence
  /** Drives accent color + icon on the card. Same hashIndex scheme as agent cards. */
  category: GoalTemplateCategory
  /** Ranked metric sources that can feed this goal, best first.
   *  'manual' is appended by the constructor if absent — no template is a dead end. */
  sources: MetricSource[]
  /** Draft-form layout (metric-index refs), single-metric widget types only. */
  layout: DashboardLayout
  /** One sentence: what number is actually read, and how often. */
  tracks: string
}
```

`GoalTemplateCategory` is a closed union: `'Revenue' | 'Pipeline' | 'Cost' | 'Retention' | 'Delivery' | 'Quality' | 'Demand'`. Closed rather than free-text so each category maps to an accent and an icon through an **explicit `Record`**, not through the agent card's `hashIndex` hashing. Deliberate: hashing over 6 accents would assign collisions arbitrarily, whereas an explicit map lets Revenue and Cost read as visually distinct even though the palette is smaller than the union.

`MetricSource` is the existing `METRIC_SOURCES` union from [`api/goals/route.ts`](../../../src/app/api/goals/route.ts). It should be lifted to `src/lib/goals/metric-sources.ts` and imported by both, so the template catalogue cannot name a source the API rejects.

### Layout presets

Authoring 45 distinct layouts is neither necessary nor maintainable. Six named presets composed from the ten single-metric widgets, assigned per template:

| Preset | Widgets, in order | Suits |
|---|---|---|
| `REVENUE_LAYOUT` | `kpi`, `trend`, `periods`, `benchmark`, `impact`, `contributions`, `history` | revenue, arr, mrr, quota |
| `COST_LAYOUT` | `kpi`, `progress`, `trend`, `impact`, `contributions`, `history` | savings, spend reduction |
| `RATE_LAYOUT` | `kpi`, `trend`, `benchmark`, `periods`, `history` | percentage KPIs |
| `COUNT_LAYOUT` | `kpi`, `progress`, `trend`, `periods`, `contributions`, `history` | count KPIs, lead gen |
| `PERSONAL_LAYOUT` | `kpi`, `progress`, `trend`, `periods`, `history` | personal-scope goals — no `rollups`, no `benchmark` |
| `ORG_ROLLUP_LAYOUT` | `kpi`, `trend`, `rollups`, `periods`, `benchmark`, `impact`, `contributions`, `history` | org goals expected to have personal children |

A `narrative` widget is **not** included in any preset — its config requires `text`, and canned copy on every templated dashboard would read as filler.

Widget ids are preset-scoped and stable (`revenue-kpi`, `revenue-trend`, …) so `parseDraftLayout`'s duplicate-id skip never fires.

### Catalogue: 45 templates

9 per department, 5 org + 4 personal. **All 20 existing keys are preserved unchanged** so bookmarked `?template=` links still resolve; each gains the four new fields.

**Sales** — existing: `sales-org-quarterly-revenue`, `sales-org-arr-growth`, `sales-personal-quota`, `sales-personal-monthly-closed`

| Key | Scope | Name | Kind | Category | Preset |
|---|---|---|---|---|---|
| `sales-org-pipeline-coverage` | org | Pipeline coverage ratio | custom_kpi (percent) | Pipeline | RATE |
| `sales-org-win-rate` | org | Improve win rate | custom_kpi (percent) | Pipeline | RATE |
| `sales-org-new-logos` | org | New logos this quarter | custom_kpi (count) | Pipeline | ORG_ROLLUP |
| `sales-personal-pipeline-created` | personal | Pipeline I created | revenue (monthly) | Pipeline | PERSONAL |
| `sales-personal-meetings-booked` | personal | Meetings booked this month | custom_kpi (count, monthly) | Pipeline | PERSONAL |

**Marketing** — existing: `marketing-org-monthly-mqls`, `marketing-org-inbound-mrr`, `marketing-personal-campaign-leads`, `marketing-personal-newsletter`

| Key | Scope | Name | Kind | Category | Preset |
|---|---|---|---|---|---|
| `marketing-org-cac` | org | Bring CAC down | savings | Cost | COST |
| `marketing-org-organic-traffic` | org | Grow organic traffic | custom_kpi (count, monthly) | Demand | COUNT |
| `marketing-org-sourced-pipeline` | org | Marketing-sourced pipeline | revenue (quarterly) | Pipeline | ORG_ROLLUP |
| `marketing-personal-content-output` | personal | Ship N pieces this month | custom_kpi (count, monthly) | Demand | PERSONAL |
| `marketing-personal-conversion-rate` | personal | Lift my landing conversion | custom_kpi (percent) | Demand | PERSONAL |

**Engineering** — existing: `engineering-org-infra-savings`, `engineering-org-open-bugs`, `engineering-personal-bug-backlog`, `engineering-personal-ship-cadence`

| Key | Scope | Name | Kind | Category | Preset |
|---|---|---|---|---|---|
| `engineering-org-deploy-frequency` | org | Deploy more often | custom_kpi (count, monthly) | Delivery | COUNT |
| `engineering-org-p1-incidents` | org | Cut Sev-1 incidents | custom_kpi (count, decrease, quarterly) | Quality | COUNT |
| `engineering-org-lead-time` | org | Shorten lead time to production | custom_kpi (count, decrease) | Delivery | ORG_ROLLUP |
| `engineering-personal-review-turnaround` | personal | Review PRs faster | custom_kpi (count, decrease) | Delivery | PERSONAL |
| `engineering-personal-test-coverage` | personal | Raise coverage on my services | custom_kpi (percent) | Quality | PERSONAL |

**Finance** — existing: `finance-org-vendor-savings`, `finance-org-collected-revenue`, `finance-personal-cost-center`, `finance-personal-dso`

| Key | Scope | Name | Kind | Category | Preset |
|---|---|---|---|---|---|
| `finance-org-gross-margin` | org | Improve gross margin | custom_kpi (percent) | Cost | RATE |
| `finance-org-burn-reduction` | org | Reduce monthly burn | savings (monthly) | Cost | COST |
| `finance-org-revenue-per-head` | org | Revenue per employee | custom_kpi (usd) | Revenue | ORG_ROLLUP |
| `finance-personal-close-cycle` | personal | Close the books faster | custom_kpi (count, decrease, monthly) | Delivery | PERSONAL |
| `finance-personal-forecast-accuracy` | personal | Tighten my forecast accuracy | custom_kpi (percent, quarterly) | Quality | PERSONAL |

**Customer Success** — existing: `csm-org-nrr`, `csm-org-expansion-mrr`, `csm-personal-renewals`, `csm-personal-churn-saves`

| Key | Scope | Name | Kind | Category | Preset |
|---|---|---|---|---|---|
| `csm-org-gross-retention` | org | Gross revenue retention | custom_kpi (percent) | Retention | RATE |
| `csm-org-csat` | org | Raise CSAT | custom_kpi (percent) | Retention | RATE |
| `csm-org-time-to-value` | org | Shorten time to first value | custom_kpi (count, decrease) | Retention | ORG_ROLLUP |
| `csm-personal-qbr-coverage` | personal | QBR coverage of my book | custom_kpi (percent, quarterly) | Retention | PERSONAL |
| `csm-personal-response-time` | personal | Respond to my accounts faster | custom_kpi (count, decrease) | Quality | PERSONAL |

Every template's `sources` is a hand-ranked subset of the nine valid sources, authored per template in build step 1 (not derived at runtime) using this ranking rule:

| Template shape | Ranking |
|---|---|
| Revenue / ARR / MRR | `stripe`, `hubspot`, `salesforce`, `google_sheets`, `manual` |
| Quota / pipeline / lead / new logos | `hubspot`, `salesforce`, `google_sheets`, `manual` |
| Engineering counts and rates | `postgres`, `google_sheets`, `url`, `manual` |
| Finance ledger figures | `postgres`, `google_sheets`, `stripe`, `manual` |
| CSM retention / CSAT | `hubspot`, `salesforce`, `postgres`, `google_sheets`, `manual` |
| Anything reported in a channel or email digest | append `slack_assisted` / `gmail_assisted` before `manual` |

`manual` is always last, and the constructor appends it if an author omits it — enforced by test #4.

### Tests

[`goal-templates.test.ts`](../../../src/lib/goals/__tests__/goal-templates.test.ts) is rewritten. Existing assertions on kind/unit consistency, key uniqueness, savings direction and key round-trip are kept. Replaced and added:

1. **Shape** — `GOAL_TEMPLATES.length === 45`; each department has exactly 9, split 5 org / 4 personal. (Replaces the 4-per / 2-2 assertions.)
2. **Layout validity** — every `layout` round-trips through `parseDraftLayout(layout, 1)` and returns a non-null layout with the same widget count. This catches a layout that silently drops widgets.
3. **Single-metric constraint** — no template layout contains a `comparison` or `ratio` widget.
4. **Source validity** — every `sources` entry is in `METRIC_SOURCES`, the list is non-empty and duplicate-free, and `manual` is present and last.
5. **Category validity** — every `category` is in the closed union and has an accent + icon mapping.
6. **Key preservation** — the 20 pre-existing keys all still resolve via `goalTemplateByKey`. Guards the bookmark contract.
7. **`tracks` present** — non-empty and distinct from `description`.

---

## Component 2 — Shared card shell

`template-catalogue-card.tsx` holds the accent palette, `hashIndex`, `categoryIcon` and the card chrome. Copying 115 lines into a goal variant guarantees the two catalogues drift.

Extract `src/components/templates/template-card-shell.tsx`:

- `ACCENTS`, `hashIndex`, `accentFor(category)` — moved verbatim
- `TemplateCardShell` — the visual chrome: accent bar, badge row, icon tile + title, description, a `tools` slot, and a CTA slot. Takes an `as` prop so it can render inside a `Link` (agent cards) or a `button` (goal cards).

`TemplateCatalogueCard` is refactored to compose the shell with no visual change; its existing behavior is the regression baseline. `categoryIcon`'s agent/flow keyword heuristics stay in the agent card — goal templates map their closed category union to icons directly, which is simpler and exact.

New `src/components/goals/goal-template-card.tsx`:

- Renders as a `button` (opens the modal), not a `Link`
- Badge row: category, Org/Personal, recurrence if set
- "Reads from" chips via `IntegrationChip`, showing the top 3 sources with `+N` overflow; unconnected sources render at reduced opacity
- CTA reads `View goal` (it opens detail, it does not create)

**Accessibility:** the card is a real `<button>` with `aria-haspopup="dialog"`; on modal close focus returns to the invoking card.

---

## Component 3 — Pagination

`GoalTemplateGallery` keeps its department tab row and gains `page` state.

- `PAGE_SIZE = 9`; grid becomes `sm:grid-cols-2 lg:grid-cols-3` so a page is a clean 3×3 block
- `pageCount = Math.ceil(visible.length / PAGE_SIZE)`; controls render only when `pageCount > 1` — so selecting a department (9 templates → 1 page) hides them
- Changing department resets `page` to 1
- Controls: prev, numbered pages, next. `aria-label="Template pages"` on a `<nav>`, `aria-current="page"` on the active number, prev/next disabled at the ends
- Page state is component-local, **not** in the URL — the gallery sits mid-page on `/goals` and must not push history entries or scroll-jump the page

### Data flow

```
GOAL_TEMPLATES (45, static)
  → filter by department tab
  → slice to page window (9)
  → GoalTemplateCard[]                 ← /api/goals/metrics/sources (connected state)
       │ click
       ▼
  GoalTemplateDetail (dialog)
       │ Use template
       ▼
  /goals/new?template=<key>            ← prefills fields + layout
       │ submit
       ▼
  POST /api/goals { ..., dashboardLayout }
       │
       ▼
  router.push(`/goals/${id}`)          → the previewed dashboard, live
```

---

## Component 4 — Detail modal and dashboard preview

`src/components/goals/goal-template-detail.tsx`, a `Dialog` opened from a card:

1. **Header** — icon tile, name, badges (category, scope, kind, recurrence)
2. **What gets tracked** — the `tracks` sentence, plus explicit direction copy ("this number should go **up**" / "**down**")
3. **Reads from** — one row per ranked source:
   - connected → check mark; the first connected source is labeled *Recommended*
   - not connected → link to that integration's connect page
   - `manual` always renders last, labeled as the fallback that needs no connection
   - Source state comes from `/api/goals/metrics/sources` via `sourceIsAvailable()`. The fetch is best-effort: on failure every source renders in a neutral unknown state rather than blocking the modal.
4. **Dashboard preview** — the real `GoalDashboard` against synthetic data, `preview: true`
5. **Footer** — `Use template` → `/goals/new?template=<key>`; `Cancel`

**Scope is stated plainly** in the header region: an org template says it creates a goal visible to the whole workspace; a personal one says it is visible only to you. Both note the wizard can change it. This is the first line of defense against the "where did my goal go" confusion.

### Shared preview data

[`copilot-preview.tsx:139-220`](../../../src/components/goals/copilot-preview.tsx#L139-L220) builds a synthetic `GoalDetail` + metric series inline. Lift it to `src/lib/goals/preview-data.ts`:

```ts
export function buildPreviewDashboardData(input: {
  name: string
  kind: GoalKind
  direction: 'increase' | 'decrease'
  unit: GoalUnit
  targetValue: number | null
  targetDate: string | null
  recurrence: GoalRecurrence
  personal: boolean
  metrics: Array<{ label: string | null; role: 'primary' | 'supporting'; unit?: GoalUnit }>
}): { data: DashboardData; metricIds: string[] }
```

`CopilotPreview` is refactored onto it — a behavior-preserving change, and it is the natural seam in a 490-line file. The template modal calls it with the template's shape and a plausible sample target, then `resolveLayoutMetricRefs(template.layout, metricIds)`.

The synthetic series is deterministic (seeded from the template key), so the preview does not shimmer between renders and is snapshot-testable.

**Preview honesty:** the preview panel is labeled as sample data. It shows the widget composition the user will get, not real numbers they do not have yet.

### Carrying the layout through

[`new/page.tsx:106-137`](../../../src/app/goals/new/page.tsx#L106-L137) already reads `?template=` and prefills six scalars. It additionally stores `entry.layout` in component state, and the submit handler sends it as `dashboardLayout`. [`api/goals/route.ts:240-246`](../../../src/app/api/goals/route.ts#L240-L246) already validates via `parseDraftLayout` and resolves index refs via `resolveLayoutMetricRefs`. **No API change.**

If a user switches the goal to a shape the layout no longer suits, the layout still renders — every widget in every preset degrades to an empty/neutral state rather than erroring. The goal detail page's existing dashboard editor ([`dashboard-edit.tsx`](../../../src/components/goals/dashboard-edit.tsx)) remains the escape hatch.

---

## Component 5 — "Where did my goal go"

Three changes, no schema work:

1. **Creation lands on the goal.** [`new/page.tsx:332`](../../../src/app/goals/new/page.tsx#L332) `router.push('/goals')` becomes `router.push('/goals/${body.goal.id}')`. Creation now ends on the dashboard the user previewed. The existing CSV-intent branch (`/goals/${id}?import=1`) is unchanged and takes precedence.
2. **Both sections always render.** [`goals/page.tsx:156-175`](../../../src/app/goals/page.tsx#L156-L175) hides an empty section. Both **Organization goals** and **My goals** headers render whenever at least one goal exists; the empty one carries a one-line hint ("No personal goals yet — personal goals are visible only to you"). A created goal is then never invisible.
3. **Scope stated in the modal**, per Component 4.

Cache invalidation on create is already correct ([`new/page.tsx:320-321`](../../../src/app/goals/new/page.tsx#L320-L321)) and needs no change.

---

## Error handling

| Failure | Behavior |
|---|---|
| `/api/goals/metrics/sources` fails | Modal opens; sources render in neutral unknown state; no connected/recommended marks. Never blocks. |
| Unknown `?template=` key | Existing behavior — `goalTemplateByKey` returns `null`, wizard starts clean. Unchanged. |
| Layout rejected by `parseDraftLayout` server-side | 400 `INVALID_LAYOUT` (already implemented). Prevented in practice by test #2. |
| Preview render throws | Preview section is wrapped in an error boundary showing "Preview unavailable"; the rest of the modal and `Use template` stay functional. |
| Page index out of range after a filter change | `page` is clamped to `[1, pageCount]` on every render. |

## Testing

**Unit** ([`goal-templates.test.ts`](../../../src/lib/goals/__tests__/goal-templates.test.ts)) — the seven assertions in Component 1.

**Unit** (`preview-data.test.ts`, new) — `buildPreviewDashboardData` returns metric ids matching the requested metric count, is deterministic for a fixed seed, and produces a `GoalDetail` that every one of the ten single-metric widgets renders without throwing.

**Unit** (`pagination.test.ts` or colocated) — page-window math: clamping, `pageCount` for 45/9 and for a filtered 9/9, reset-on-department-change.

**Route smoke** (per the `verify` skill) — `POST /api/goals` with a template's draft layout persists a resolved `dashboardLayout` whose widget ids and count match the preset, and whose `metricId` refs point at the created primary metric. `GET /api/goals` then returns the goal with the correct `personal` flag for both an org-scoped and a personal-scoped template.

**Manual** — click a template, confirm the modal preview widgets match the goal detail page after creation; confirm an org-scoped template lands on its dashboard and is visible under Organization goals with My goals still rendered and hinted.

## Build sequence

1. `metric-sources.ts` extraction + `GoalTemplate` type fields + layout presets + catalogue to 45 + rewritten tests
2. `preview-data.ts` extraction; refactor `CopilotPreview` onto it (behavior-preserving, tests green before proceeding)
3. `template-card-shell.tsx` extraction; refactor `TemplateCatalogueCard` (no visual change)
4. `goal-template-card.tsx`
5. `goal-template-detail.tsx` modal with source rows + preview
6. `GoalTemplateGallery` pagination + wiring cards to the modal
7. Layout carried through `new/page.tsx` into `POST /api/goals`
8. Component 5 — redirect to the goal, always-render both sections

Steps 2 and 3 are pure refactors and land first so the new components build on stable seams.

## Open risks

- **45 templates is a lot of authored copy.** Names, descriptions, `tracks` sentences and source rankings must be genuinely useful, not padding. If a department cannot support 9 real templates, the honest answer is fewer — the tests should then be updated to match reality rather than the catalogue padded to satisfy them.
- **`TemplateCatalogueCard` refactor is a regression surface.** It is used by the agent and flow catalogues. Step 3 must be verifiably no-visual-change before step 4 builds on it.
