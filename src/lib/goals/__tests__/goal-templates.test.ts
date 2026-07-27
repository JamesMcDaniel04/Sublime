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

test('catalogue shape: 9 per served department, 5 org + 4 personal', () => {
  assert.equal(GOAL_TEMPLATES.length, PRODUCT_DEPARTMENTS.length * 9)
  for (const department of PRODUCT_DEPARTMENTS) {
    const entries = GOAL_TEMPLATES.filter((entry) => entry.department === department)
    assert.equal(entries.length, 9, `${department} should have 9 templates`)
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
