/**
 * Connector registry — the single source of truth for the tool "planes" an
 * agent can attach.
 *
 * Before this, plane gating was scattered as fuzzy regexes over the agent's
 * `integrations` JSON (`/slack/i`, `/granola/i`, `new RegExp(capability)`) in
 * loadTools, DUPLICATED again in /api/integrations/available, with
 * write-vs-read classification hard-coded per call site. A drifting key in
 * one place silently disabled an integration in another.
 *
 * Now every built-in plane is one typed descriptor: its canonical key, how a
 * stored selection activates it (`matches`), whether it is an outbound-write
 * plane, its env availability, and its UI presentation. loadTools, the
 * available-integrations endpoint, and the audit write classification
 * all derive from here.
 *
 * Dynamic planes (per-org MCP connections) are discovered from DB rows
 * rather than declared here.
 */
import { slackConfigured } from '@/lib/integrations/slack'
import { emailConfigured } from '@/lib/integrations/email'

export type ConnectorKind = 'builtin' | 'nango' | 'postgres'

export type ConnectorDescriptor = {
  /** Canonical key persisted on the agent + shown in the UI. */
  key: string
  label: string
  /** Simple Icons slug for the UI chip. */
  slug: string
  kind: ConnectorKind
  /** True for outbound/delivery planes (writes) — reserved cap budget. */
  isWrite: boolean
  /**
   * Human approval is MANDATORY for this plane's calls, regardless of whether
   * the agent opted into approvals. Reserved for planes where the model
   * authors the side effect itself against customer-owned infrastructure —
   * today only Postgres writes.
   */
  alwaysRequiresApproval?: boolean
  /** The runtime `binding.provider` this plane produces (e.g. 'nango:slack'). */
  providerId: string
  /** Does a user-selected integration string activate this connector? */
  matches: (selected: string) => boolean
  /** Env availability. Granola is per-org (async), handled at its call site. */
  available: () => boolean
}

/** Case-insensitive substring match — behavior-preserving vs the old regexes. */
const has = (needle: string) => (selected: string) => selected.toLowerCase().includes(needle)

export const BUILTIN_CONNECTORS: ConnectorDescriptor[] = [
  {
    key: 'Granola',
    label: 'Granola',
    slug: 'granola',
    kind: 'builtin',
    isWrite: false,
    providerId: 'granola',
    matches: has('granola'),
    available: () => true, // gated per-org by an API key at the call site
  },
  {
    key: 'Slack',
    label: 'Slack',
    slug: 'slack',
    kind: 'builtin',
    isWrite: true,
    providerId: 'slack',
    matches: has('slack'),
    available: () => slackConfigured(),
  },
  {
    key: 'Email',
    label: 'Email',
    slug: 'resend',
    kind: 'builtin',
    isWrite: true,
    providerId: 'email',
    matches: has('email'),
    available: () => emailConfigured(),
  },
  {
    key: 'HTTP API',
    label: 'HTTP API',
    slug: 'http',
    kind: 'builtin',
    isWrite: true, // can POST to external systems
    providerId: 'http',
    matches: has('http'),
    available: () => true, // no credentials required; SSRF-guarded at call time
  },
  {
    key: 'goals',
    label: 'Goals',
    slug: 'sublime',
    kind: 'builtin',
    isWrite: true, // can record datapoints on AI/human-owned metrics
    providerId: 'sublime-goals',
    matches: has('goal'),
    available: () => true, // no credentials; scoped by GoalContribution at load time
  },
  // Native Postgres. Unlike every plane above, this one is not a single
  // connection: an org connects N named databases, and the plane loader builds
  // one group per database (see loadPostgresPlaneGroups). The descriptor here
  // exists for selection matching, the picker chip, and audit classification.
  {
    key: 'postgres',
    label: 'PostgreSQL',
    slug: 'postgresql',
    kind: 'postgres',
    isWrite: false,
    providerId: 'postgres',
    matches: (selected) => /postgres|postgresql|database/i.test(selected),
    available: () => true, // gated per-org by a connected database at the call site
  },
  {
    // Never user-selected and never shown in a picker: the write plane is
    // activated per-database by the connection's allowWrites column. It exists
    // as its own descriptor so isWriteProvider classifies its audit events and
    // alwaysRequiresApproval resolves for the approval gate.
    key: 'postgres:write',
    label: 'PostgreSQL (write)',
    slug: 'postgresql',
    kind: 'postgres',
    isWrite: true,
    alwaysRequiresApproval: true,
    providerId: 'postgres:write',
    matches: () => false,
    available: () => true,
  },
  // Nango delivery planes (outbound as the acting user). One per capability.
  {
    key: 'slack',
    label: 'Slack (send)',
    slug: 'slack',
    kind: 'nango',
    isWrite: true,
    providerId: 'nango:slack',
    matches: has('slack'),
    available: () => true, // gated by a resolvable Nango connection at the call site
  },
  {
    key: 'gmail',
    label: 'Gmail',
    slug: 'gmail',
    kind: 'nango',
    isWrite: true,
    providerId: 'nango:gmail',
    matches: has('gmail'),
    available: () => true,
  },
  {
    key: 'sheets',
    label: 'Google Sheets',
    slug: 'googlesheets',
    kind: 'nango',
    isWrite: true,
    providerId: 'nango:sheets',
    matches: has('sheet'),
    available: () => true,
  },
  {
    key: 'drive',
    label: 'Google Drive',
    slug: 'googledrive',
    kind: 'nango',
    isWrite: true,
    providerId: 'nango:drive',
    matches: has('drive'),
    available: () => true,
  },
  {
    key: 'calendar',
    label: 'Google Calendar',
    slug: 'googlecalendar',
    kind: 'nango',
    isWrite: true,
    providerId: 'nango:calendar',
    matches: has('calendar'),
    available: () => true,
  },
  {
    key: 'analytics',
    label: 'Google Analytics',
    slug: 'googleanalytics',
    kind: 'nango',
    isWrite: true,
    providerId: 'nango:analytics',
    matches: has('analytic'),
    available: () => true,
  },
  {
    key: 'salesforce',
    label: 'Salesforce',
    slug: 'salesforce',
    kind: 'nango',
    isWrite: true,
    providerId: 'nango:salesforce',
    matches: has('salesforce'),
    available: () => true,
  },
  {
    key: 'asana',
    label: 'Asana',
    slug: 'asana',
    kind: 'nango',
    isWrite: true,
    providerId: 'nango:asana',
    matches: has('asana'),
    available: () => true,
  },
  {
    key: 'clickup',
    label: 'ClickUp',
    slug: 'clickup',
    kind: 'nango',
    isWrite: true,
    providerId: 'nango:clickup',
    matches: has('clickup'),
    available: () => true,
  },
  {
    key: 'confluence',
    label: 'Confluence',
    slug: 'confluence',
    kind: 'nango',
    isWrite: true,
    providerId: 'nango:confluence',
    matches: has('confluence'),
    available: () => true,
  },
  {
    key: 'github',
    label: 'GitHub',
    slug: 'github',
    kind: 'nango',
    isWrite: true,
    providerId: 'nango:github',
    matches: has('github'),
    available: () => true,
  },
  {
    key: 'intercom',
    label: 'Intercom',
    slug: 'intercom',
    kind: 'nango',
    isWrite: true, // nango:* planes are write planes by construction (see isWriteProvider)
    providerId: 'nango:intercom',
    matches: has('intercom'),
    available: () => true,
  },
  {
    key: 'monday',
    label: 'Monday',
    slug: 'monday',
    kind: 'nango',
    isWrite: true,
    providerId: 'nango:monday',
    matches: has('monday'),
    available: () => true,
  },
  {
    key: 'perplexity',
    label: 'Perplexity',
    slug: 'perplexity',
    kind: 'nango',
    isWrite: true,
    providerId: 'nango:perplexity',
    matches: has('perplexity'),
    available: () => true,
  },
]

/** Nango delivery capability → its registry descriptor (by capability name). */
export function nangoConnector(capability: string): ConnectorDescriptor | undefined {
  return BUILTIN_CONNECTORS.find((c) => c.kind === 'nango' && c.key === capability)
}

/** True if any selected integration string activates this connector. */
export function isSelected(descriptor: ConnectorDescriptor, selected: string[]): boolean {
  return selected.some((s) => descriptor.matches(s))
}

/**
 * Whether a runtime provider id is an outbound-WRITE plane (reserved cap budget,
 * audit `tool.write`). Derived from the registry for built-ins;
 * any `nango:*` provider is a write plane by construction.
 */
export function isWriteProvider(providerId: string): boolean {
  if (providerId.startsWith('nango:')) return true
  return BUILTIN_CONNECTORS.some((c) => c.providerId === providerId && c.isWrite)
}

/**
 * Whether this plane's calls must pause for a human EVEN IF the agent never
 * opted into approvals.
 *
 * The ordinary approval gate is per-agent and defaults off, which is the right
 * default for planes whose blast radius is a message. It is the wrong default
 * for a model-authored statement against a customer's production database, so
 * that plane carries the requirement itself.
 */
export function alwaysRequiresApproval(providerId: string): boolean {
  return BUILTIN_CONNECTORS.some((c) => c.providerId === providerId && c.alwaysRequiresApproval === true)
}

// ── UI key derivation (shared with /api/integrations/available) ───────────────
const titleCase = (s: string) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

/** Nango providerConfigKey → a runtime-matchable key + display + icon slug. */
export function fromNangoProviderKey(providerConfigKey: string): { key: string; label: string; slug: string } {
  const k = providerConfigKey.toLowerCase()
  if (k.includes('slack')) return { key: 'slack', label: 'Slack', slug: 'slack' }
  // Google services before the broad 'mail' match — order matters.
  if (k.includes('sheet')) return { key: 'sheets', label: 'Google Sheets', slug: 'googlesheets' }
  if (k.includes('drive')) return { key: 'drive', label: 'Google Drive', slug: 'googledrive' }
  if (k.includes('calendar')) return { key: 'calendar', label: 'Google Calendar', slug: 'googlecalendar' }
  if (k.includes('analytic')) return { key: 'analytics', label: 'Google Analytics', slug: 'googleanalytics' }
  if (k.includes('mail') || k.includes('gmail')) return { key: 'gmail', label: 'Gmail', slug: 'gmail' }
  if (k.includes('salesforce')) return { key: 'salesforce', label: 'Salesforce', slug: 'salesforce' }
  if (k.includes('github')) return { key: 'github', label: 'GitHub', slug: 'github' }
  if (k.includes('intercom')) return { key: 'intercom', label: 'Intercom', slug: 'intercom' }
  if (k.includes('clickup')) return { key: 'clickup', label: 'ClickUp', slug: 'clickup' }
  return { key: k, label: titleCase(k), slug: k }
}

