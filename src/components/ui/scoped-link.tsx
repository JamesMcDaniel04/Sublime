'use client'

/**
 * next/link that keeps the caller's goal lens.
 *
 * Imported as `import { ScopedLink as Link }` so a file's existing <Link> tags
 * become scope-aware with a one-line change and no per-tag edits — which is
 * what makes converting the whole app tractable, and what stops the conversion
 * being half-done in a way nobody notices until they lose their lens mid-task.
 *
 * Non-app hrefs (/settings, /templates, absolute URLs) pass through untouched;
 * see scopedHref for the closed list of what actually gets scoped.
 */

import NextLink from 'next/link'
import type { ComponentProps } from 'react'
import { useScopedHref } from '@/lib/client/scoped-href'

type ScopedLinkProps = Omit<ComponentProps<typeof NextLink>, 'href'> & { href: string }

export function ScopedLink({ href, ...props }: Readonly<ScopedLinkProps>) {
  const scoped = useScopedHref()
  return <NextLink href={scoped(href)} {...props} />
}
