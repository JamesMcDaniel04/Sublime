import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GOAL_TEMPLATES,
  GOAL_TEMPLATE_CATEGORIES,
  VISIBLE_GOAL_TEMPLATES,
  REVOPS_TEMPLATES,
  goalTemplateByKey,
} from '../goal-templates'
import { AGENT_WRITABLE_SOURCES } from '@/lib/goals/agent-tool-policy'
import { getSeedByKey } from '@/lib/templates/catalogue'
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

test('catalogue shape: 9 visible per served department, 5 org + 4 personal', () => {
  assert.equal(VISIBLE_GOAL_TEMPLATES.length, PRODUCT_DEPARTMENTS.length * 9)
  for (const department of PRODUCT_DEPARTMENTS) {
    const entries = VISIBLE_GOAL_TEMPLATES.filter((entry) => entry.department === department)
    assert.equal(entries.length, 9, `${department} should have 9 visible templates`)
    assert.equal(entries.filter((entry) => entry.scope === 'org').length, 5, `${department} org split`)
    assert.equal(entries.filter((entry) => entry.scope === 'personal').length, 4, `${department} personal split`)
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

test('spend-reduction templates keep usd and decrease; lookup by key round-trips', () => {
  // These three were kind 'savings', which implied BOTH usd and decrease. That
  // kind collapsed into 'kpi' (spec 2026-07-28), which implies neither — so
  // they now state both outright and this locks it. Without the explicit unit
  // they would silently fall through to 'count' and report dollars as a tally.
  //
  // Keyed by name rather than by category: 'Cost' also covers DSO (a count),
  // gross margin (a percent that should go UP), and action templates counting
  // reviews — so category is not the invariant.
  for (const key of [
    'engineering-org-infra-savings',
    'finance-org-vendor-savings',
    'finance-personal-cost-center',
  ]) {
    const entry = goalTemplateByKey(key)
    assert.ok(entry, `${key} missing`)
    assert.equal(entry.unit, 'usd', `${key}: spend is money, not a count`)
    assert.equal(entry.direction, 'decrease', `${key}: spending less is the win`)
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

test('every template declares a motion', () => {
  for (const entry of GOAL_TEMPLATES) {
    assert.ok(
      entry.motion === 'outcome' || entry.motion === 'action',
      `${entry.key}: motion must be outcome or action, got ${entry.motion}`,
    )
  }
})

test('produces belongs to action templates and only to them', () => {
  for (const entry of GOAL_TEMPLATES) {
    if (entry.motion === 'action') {
      assert.ok(
        entry.produces && entry.produces.trim().length > 0,
        `${entry.key}: an action template must name what it produces`,
      )
    } else {
      assert.equal(entry.produces, undefined, `${entry.key}: outcome templates do not produce`)
    }
  }
})

test('action templates count agent output, outcome templates never do', () => {
  for (const entry of GOAL_TEMPLATES) {
    const selfReporting = entry.sources.every((source) => AGENT_WRITABLE_SOURCES.has(source))
    assert.equal(
      selfReporting,
      entry.motion === 'action',
      `${entry.key}: an action template's sources must all be agent-writable, and an ` +
        `outcome template's must not all be — otherwise the goal-native collector ` +
        `can or cannot log it, contradicting the motion`,
    )
  }
})

test('retired templates resolve by key but leave the visible catalogue', () => {
  const retired = GOAL_TEMPLATES.filter((entry) => entry.retired)
  for (const entry of retired) {
    assert.ok(goalTemplateByKey(entry.key), `${entry.key}: must still resolve for bookmarks`)
    assert.ok(
      !VISIBLE_GOAL_TEMPLATES.includes(entry),
      `${entry.key}: retired templates must not reach the gallery`,
    )
  }
  assert.equal(VISIBLE_GOAL_TEMPLATES.length, GOAL_TEMPLATES.length - retired.length)
})

test('every curated agent on an action template exists in the seed catalogue', () => {
  for (const entry of GOAL_TEMPLATES.filter((candidate) => candidate.motion === 'action')) {
    assert.ok(entry.agents.length > 0, `${entry.key}: an action template needs curated agents`)
    for (const seedKey of entry.agents) {
      assert.ok(getSeedByKey(seedKey), `${entry.key}: unknown seed ${seedKey}`)
    }
  }
})

test('sales leads with the work: 6 action, 3 outcome, 1 retired', () => {
  const sales = VISIBLE_GOAL_TEMPLATES.filter((entry) => entry.department === 'sales')
  assert.equal(sales.filter((entry) => entry.motion === 'action').length, 6)
  assert.equal(sales.filter((entry) => entry.motion === 'outcome').length, 3)
  assert.equal(goalTemplateByKey('sales-org-arr-growth')?.retired, true)
})

test('every department carries action templates in the agreed mix', () => {
  const expected: Record<string, number> = {
    sales: 6, marketing: 4, engineering: 3, finance: 3, csm: 4,
  }
  for (const [department, count] of Object.entries(expected)) {
    const actual = VISIBLE_GOAL_TEMPLATES.filter(
      (entry) => entry.department === department && entry.motion === 'action',
    ).length
    assert.equal(actual, count, `${department}: expected ${count} action templates, got ${actual}`)
  }
  assert.equal(VISIBLE_GOAL_TEMPLATES.filter((entry) => entry.motion === 'action').length, 20)
})

test('the RevOps lens is the standards a process owner rolls out', () => {
  assert.equal(REVOPS_TEMPLATES.length, 8)
  for (const entry of REVOPS_TEMPLATES) {
    assert.equal(entry.scope, 'org', `${entry.key}: a RevOps buyer carries no personal number`)
    assert.equal(entry.motion, 'action', `${entry.key}: a play is work, not a metric`)
    assert.ok(
      ['sales', 'marketing', 'csm'].includes(entry.department),
      `${entry.key}: RevOps spans the revenue-owning departments only`,
    )
  }
})

test('the lens never surfaces a personal or outcome template', () => {
  const keys = new Set(REVOPS_TEMPLATES.map((entry) => entry.key))
  // The buyer owns the process; these are for the people doing the work.
  assert.equal(keys.has('sales-personal-revive-stalled-deals'), false)
  assert.equal(keys.has('sales-personal-quota'), false)
  assert.equal(keys.has('sales-org-quarterly-revenue'), false, 'an outcome is not a play')
})

test('every RevOps template is also in the visible catalogue', () => {
  // The lens is a filter, never a second source of templates.
  for (const entry of REVOPS_TEMPLATES) {
    assert.ok(VISIBLE_GOAL_TEMPLATES.includes(entry), `${entry.key}: must be the same object`)
  }
})

test("RevOps plays are phrased as standards, not as a rep's to-do", () => {
  // "Multithread every open deal" is something you do. "Every open deal is
  // multithreaded" is something you can be FAILING at — which is what a
  // process owner buys a tool to find out.
  const IMPERATIVE_OPENERS =
    /^(work|multithread|qualify|close|revive|follow|ship|build|review|capture|explain|plan)\b/i
  for (const entry of REVOPS_TEMPLATES) {
    assert.equal(
      IMPERATIVE_OPENERS.test(entry.name),
      false,
      `${entry.key}: "${entry.name}" reads as an instruction to a person`,
    )
  }
})

test('renaming never changes a key', () => {
  // Bookmarked /goals/new?template=<key> links outlive any amount of copy.
  for (const key of [
    'sales-org-multithread-open-deals',
    'sales-org-qualify-inbound-same-day',
    'sales-org-close-plan-on-commit',
    'sales-org-work-the-whitespace',
    'marketing-org-work-every-event-lead',
    'marketing-org-brief-every-launch',
    'csm-org-plan-every-new-account',
    'csm-org-close-every-adoption-gap',
  ]) {
    assert.ok(goalTemplateByKey(key), `${key} must still resolve`)
  }
})
