'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * Brand logo for an integration/MCP provider.
 *
 * Source order: an explicit `src` (e.g. Nango's brand-logo CDN, returned by the
 * integrations API) → Simple Icons CDN by provider slug → a monochrome initial
 * tile. Any load error falls through to the next source, so a missing logo
 * never leaves a broken image.
 */

// Nango provider key → Simple Icons slug (https://simpleicons.org).
// Only entries that differ from the raw provider key, or need pinning, matter;
// unmapped providers try the key itself, then fall back to an initial tile.
const SIMPLE_ICON_SLUGS: Record<string, string> = {
  github: 'github',
  slack: 'slack',
  linear: 'linear',
  jira: 'jira',
  asana: 'asana',
  notion: 'notion',
  zendesk: 'zendesk',
  hubspot: 'hubspot',
  monday: 'mondaydotcom',
  gmail: 'gmail',
  'google-mail': 'gmail',
  googlemail: 'gmail',
  salesforce: 'salesforce',
  'salesforce-sandbox': 'salesforce',
  snowflake: 'snowflake',
  airtable: 'airtable',
  confluence: 'confluence',
  trello: 'trello',
  clickup: 'clickup',
  'google-drive': 'googledrive',
  googledrive: 'googledrive',
  launchdarkly: 'launchdarkly',
  'launch-darkly': 'launchdarkly',
  googlecalendar: 'googlecalendar',
  googledocs: 'googledocs',
  googleforms: 'googleforms',
  googlecloud: 'googlecloud',
  supabase: 'supabase',
  intercom: 'intercom',
  figma: 'figma',
}

function simpleIconUrl(slug: string): string {
  // Brand-colored SVG, no API key. Falls back gracefully via onError.
  return `https://cdn.simpleicons.org/${slug}`
}

/**
 * Strip separators from a provider key so underscore/hyphen/space variants
 * (e.g. "google_calendar", "google-calendar", "Google Calendar") resolve to
 * the same Simple Icons slug ("googlecalendar"). Simple Icons slugs are
 * always lowercase and separator-free, so this normalization is always safe
 * as a fallback when no explicit SIMPLE_ICON_SLUGS mapping exists.
 */
export function normalizeIconSlug(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, '')
}

// Bundled brand assets (public/logos), preferred over any passed src or the
// Simple Icons CDN — used wherever a provider's logo renders (run logs, cards,
// integrations catalogue). Keyed by NORMALIZED slug (separators stripped) so
// "google_drive", "google-drive" and "googledrive" all resolve to one asset.
const LOCAL_LOGOS: Record<string, string> = {
  slack: '/logos/slack.svg',
  granola: '/logos/granola.jpg',
  figma: '/logos/figma.svg',
  // Salesforce was removed from the Simple Icons CDN (trademark), so bundle it.
  salesforce: '/logos/salesforce.svg',
  sublime: '/sublime-icon.png',
  googledrive: '/logos/googledrive.svg',
  googlesheets: '/logos/googlesheets.webp',
  monday: '/logos/monday.jpg',
  mondaydotcom: '/logos/monday.jpg',
  qwen: '/logos/qwen.webp',
}

// Providers that do not publish a Simple Icons asset. Google's favicon
// service returns the actual company site icon at a stable, high-resolution
// URL; keeping these mappings here also makes every integration surface use
// the same brand mark instead of an initial tile.
const BRAND_LOGOS: Record<string, string> = {
  plai: 'https://www.google.com/s2/favicons?domain=plai.io&sz=128',
  close: 'https://www.google.com/s2/favicons?domain=close.com&sz=128',
  motion: 'https://www.google.com/s2/favicons?domain=usemotion.com&sz=128',
  microsoftteams: 'https://www.google.com/s2/favicons?domain=teams.microsoft.com&sz=128',
  amplitude: 'https://www.google.com/s2/favicons?domain=amplitude.com&sz=128',
}

function localLogo(slug: string): string | undefined {
  const key = slug.replace(/[-_\s]/g, '')
  // Custom Sublime MCP connections slugify to sublime_mcp / sublimemcp /
  // "sublime mcp" etc.; any variant containing "sublime" gets the mark.
  if (key.includes('sublime')) return LOCAL_LOGOS.sublime
  return LOCAL_LOGOS[key]
}

export function IntegrationLogo({
  src,
  slug,
  name,
  className,
}: {
  src?: string | null
  slug?: string | null
  name: string
  className?: string
}) {
  const key = (slug || '').toLowerCase()
  // A bundled asset wins; otherwise prefer an explicit catalogue logo, then
  // the small set of provider-specific fallbacks above.
  const normalized = normalizeIconSlug(key)
  const effectiveSrc = localLogo(key) ?? src ?? BRAND_LOGOS[key] ?? BRAND_LOGOS[normalized]
  const iconSlug = SIMPLE_ICON_SLUGS[key] ?? SIMPLE_ICON_SLUGS[normalized] ?? (normalized || null)
  // 0 = explicit/local src, 1 = simple-icons, 2 = initial fallback.
  const initialStage = effectiveSrc ? 0 : slug ? 1 : 2
  const [stage, setStage] = useState(initialStage)

  const box = cn('flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded', className)

  if (stage === 0 && effectiveSrc) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={effectiveSrc}
        alt=""
        className={box}
        onError={() => setStage(iconSlug ? 1 : 2)}
      />
    )
  }

  if (stage === 1 && iconSlug) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={simpleIconUrl(iconSlug)}
        alt=""
        className={box}
        onError={() => setStage(2)}
      />
    )
  }

  return (
    <span
      className={cn(box, 'bg-gray-100 text-[11px] font-semibold uppercase text-gray-600')}
      aria-hidden
    >
      {name.trim().charAt(0) || '?'}
    </span>
  )
}
