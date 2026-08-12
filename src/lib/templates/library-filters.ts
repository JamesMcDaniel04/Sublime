/**
 * The filtering the library grids share — templates, skills, and the flow
 * gallery.
 *
 * Before this, the library's search box did not search: typing only set state,
 * and the grid stayed as it was until you pressed Enter for an AI-suggestions
 * panel rendered beside the unfiltered cards. The department pills narrowed the
 * Starter catalogue alone, so a user's own templates and every skill ignored
 * them. Search and department now mean the same thing on every grid.
 *
 * Department is DERIVED where it is not stored. Only seed rows carry a
 * `departments` array (see @/lib/templates/catalogue); a hand-authored template,
 * an auto-distilled one, and every skill carry none. Backfilling a column would
 * still leave community and future rows unfilterable, so a department is read
 * from what an item already has: its integrations first (via the shared
 * ANCHOR_DEPARTMENTS taxonomy in ./departments), then its classification text.
 *
 * The description is deliberately excluded from classification — a template
 * whose prose mentions marketing is not a marketing template — but it IS
 * searched, because search is a different question from classification.
 *
 * Pure: no I/O, no React.
 */
import { DEPARTMENTS, departmentsForTools, type Department } from './departments'

/** The "everything" choice both dropdowns fall back to. */
export const ALL_FILTER = 'all'

/**
 * Classification words that place an item in a department, matched whole-word
 * so "it" does not fire inside "with" and "ae" not inside "aggregate".
 *
 * `general` is absent on purpose: it is the BI fallback classification, not a
 * department someone filters by (see PRODUCT_DEPARTMENTS).
 */
const DEPARTMENT_KEYWORDS: Record<Exclude<Department, 'general'>, string[]> = {
  sales: [
    'sales', 'seller', 'sellers', 'selling', 'ae', 'aes', 'revops', 'revenue', 'quota', 'pipeline',
    'forecast', 'forecasting', 'opportunity', 'opportunities', 'deal', 'deals', 'prospect',
    'prospecting', 'discovery', 'account', 'accounts', 'territory', 'upsell', 'expansion', 'crm',
    'outbound', 'cro',
  ],
  engineering: [
    'engineering', 'engineer', 'engineers', 'developer', 'developers', 'dev', 'devops', 'platform',
    'infrastructure', 'architecture', 'architect', 'api', 'apis', 'code', 'deploy', 'deployment',
    'incident', 'incidents', 'bug', 'bugs', 'release', 'releases', 'sprint', 'qa', 'security', 'it',
    'technical', 'data',
  ],
  marketing: [
    'marketing', 'campaign', 'campaigns', 'demand', 'abm', 'content', 'brand', 'seo', 'social',
    'event', 'events', 'lead', 'leads', 'nurture', 'webinar', 'audience', 'launch',
  ],
  finance: [
    'finance', 'financial', 'billing', 'invoice', 'invoices', 'invoicing', 'revenue', 'spend',
    'budget', 'budgets', 'cost', 'costs', 'expense', 'expenses', 'procurement', 'arr', 'mrr',
    'forecast', 'accounting', 'payment', 'payments',
  ],
  csm: [
    'csm', 'csms', 'cs', 'customer', 'customers', 'success', 'renewal', 'renewals', 'retention',
    'adoption', 'churn', 'onboarding', 'support', 'health', 'escalation', 'escalations', 'ticket',
    'tickets',
  ],
}

/** Filterable departments, in canonical order. Excludes the `general` fallback. */
const FILTERABLE = DEPARTMENTS.filter((d): d is Exclude<Department, 'general'> => d !== 'general')

/** Whole-word matcher, precompiled once per department. */
const DEPARTMENT_PATTERNS = FILTERABLE.map((department) => ({
  department,
  pattern: new RegExp(`(?:^|[^a-z0-9])(?:${DEPARTMENT_KEYWORDS[department].join('|')})(?:[^a-z0-9]|$)`),
}))

/**
 * The fields a library item can be filtered on. Every grid's row satisfies
 * this structurally, so no grid needs an adapter.
 */
export type LibraryItem = {
  name?: string | null
  description?: string | null
  category?: string | null
  tags?: string[] | null
  /** Skills state their reader in job titles ("AEs", "RevOps"). */
  audience?: string[] | null
  integrations?: string[] | null
  requiredIntegrations?: string[] | null
  recommendedIntegrations?: string[] | null
  /** Stored on seed rows only; authoritative when present. */
  departments?: string[] | null
}

/** Classification text a department is read from — never the description. */
const classificationText = (item: LibraryItem) =>
  [item.category ?? '', ...(item.tags ?? []), ...(item.audience ?? [])].join(' ').toLowerCase()

/** Every integration slug an item names, from whichever field carries them. */
const integrationsOf = (item: LibraryItem) => [
  ...(item.integrations ?? []),
  ...(item.requiredIntegrations ?? []),
  ...(item.recommendedIntegrations ?? []),
]

/**
 * Every department an item belongs to, in canonical order.
 *
 * A stored `departments` array wins outright — a seed row states its audience
 * and we should not second-guess it. Otherwise the anchor-tool taxonomy and the
 * classification keywords are unioned; both are additive, so an item reachable
 * by neither returns empty and shows only under "All departments". That is
 * honest about the fact that we are inferring rather than reading a field.
 */
export function departmentsFor(item: LibraryItem): Department[] {
  const stored = (item.departments ?? []).filter((d): d is Department =>
    FILTERABLE.includes(d as Exclude<Department, 'general'>))
  if (stored.length) return FILTERABLE.filter((d) => stored.includes(d))

  const hits = new Set<Department>()
  // 'general' means "no anchor tool matched" — not a department, so drop it.
  for (const dept of departmentsForTools(integrationsOf(item))) {
    if (dept !== 'general') hits.add(dept)
  }
  const text = classificationText(item)
  for (const { department, pattern } of DEPARTMENT_PATTERNS) {
    if (pattern.test(text)) hits.add(department)
  }
  return FILTERABLE.filter((d) => hits.has(d))
}

/** Filter predicate for the Department dropdown. ALL_FILTER admits everything. */
export function hasDepartment(item: LibraryItem, department: string): boolean {
  if (department === ALL_FILTER) return true
  return departmentsFor(item).includes(department as Department)
}

/** Filter predicate for the Category dropdown. ALL_FILTER admits everything. */
export function hasCategory(item: LibraryItem, category: string): boolean {
  if (category === ALL_FILTER) return true
  return (item.category ?? '').trim().toLowerCase() === category.trim().toLowerCase()
}

/**
 * Free-text match. Unlike classification this DOES read the description —
 * someone typing "churn" is looking for anything about churn, not for items
 * formally classified under it.
 *
 * Every whitespace-separated term must match somewhere (AND), so adding a word
 * always narrows. Matching is substring, not whole-word, so "renew" finds
 * "renewal" as the user types.
 */
export function matchesSearch(item: LibraryItem, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const haystack = [
    item.name ?? '',
    item.description ?? '',
    item.category ?? '',
    ...(item.tags ?? []),
    ...(item.audience ?? []),
    ...integrationsOf(item),
  ].join(' ').toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

/** Search + category + department, in one predicate per grid. */
export function matchesLibraryFilters(
  item: LibraryItem,
  filters: { search: string; category: string; department: string },
): boolean {
  return (
    matchesSearch(item, filters.search)
    && hasCategory(item, filters.category)
    && hasDepartment(item, filters.department)
  )
}

/**
 * The categories actually present in a grid, deduped case-insensitively and
 * sorted for display. Derived from the rows rather than a constant so a new
 * category — a custom template, a community skill — appears in the dropdown
 * without a code change, and a category nothing uses never does.
 */
export function categoriesOf(items: LibraryItem[]): string[] {
  const seen = new Map<string, string>()
  for (const item of items) {
    const label = (item.category ?? '').trim()
    if (!label) continue
    const key = label.toLowerCase()
    if (!seen.has(key)) seen.set(key, label)
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}
