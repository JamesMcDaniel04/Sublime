/**
 * Whether a workspace can start a template today. Pure so the card and the
 * gallery cannot disagree.
 *
 * The rule has to branch on motion. An outcome template is inert until a
 * system of record is connected. An action template counts the agents' own
 * output, so its metric needs nothing at all — its real prerequisite is that
 * at least one of the agents doing the work can run. Scoring action templates
 * on their metric source would mark every one of them not-ready (they read
 * `manual`) and sort the day-one templates to the bottom of the grid, which is
 * exactly backwards.
 */
import type { GoalTemplate } from '@/lib/goals/goal-templates'
import { bundleForGoal } from '@/lib/goals/agent-bundle'

export function templateIsReady(
  template: GoalTemplate,
  connectedSources: Set<string>,
  connectedIntegrations: Set<string>,
): boolean {
  if (template.motion === 'action') {
    // source: null — the metric source is chosen later in the wizard.
    const bundle = bundleForGoal({
      templateKey: template.key,
      kind: template.kind,
      source: null,
      recurrence: template.recurrence,
    })
    return bundle.some(
      (entry) =>
        entry.origin === 'curated' &&
        // An agent with no requirements would pass `every` vacuously and mark
        // the card ready on an empty workspace.
        entry.requiredIntegrations.length > 0 &&
        entry.requiredIntegrations.every((integration) =>
          connectedIntegrations.has(integration),
        ),
    )
  }

  // `manual` is excluded: every template can fall back to manual entry, so
  // counting it would mark all of them ready and say nothing.
  return template.sources.some(
    (source) => source !== 'manual' && connectedSources.has(source),
  )
}
