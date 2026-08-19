import { redirect } from 'next/navigation'

/**
 * Activity folded into Traces — one surface answers "what happened?", whether
 * the actor was one of your agents or one of your connected tools.
 *
 * Kept as a redirect rather than deleted: the path is in bookmarks and in
 * notification links that predate the merge, and landing on the right tab is
 * the difference between "moved" and "gone".
 */
export default function ActivityPage() {
  redirect('/traces?tab=activity')
}
