import { redirect } from 'next/navigation'

/**
 * The template library now lives inside Agent HQ (/dashboard?view=templates),
 * toggled alongside Agents at the top of that page. This route survives only
 * so old links, bookmarks, and the ?tab=skills deep link keep resolving —
 * template DETAIL pages (/templates/[id]) still live under this prefix.
 */
export default async function TemplatesIndexRedirect({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  const { tab } = await searchParams
  redirect(tab === 'skills' ? '/dashboard?view=templates&tab=skills' : '/dashboard?view=templates')
}
