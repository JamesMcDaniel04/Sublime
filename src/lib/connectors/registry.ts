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

export type ConnectorKind = 'builtin' | 'nango'

export type ConnectorDescriptor = {
  /** Canonical key persisted on the agent + shown in the UI. */
  key: string
  label: string
  /** Simple Icons slug for the UI chip. */
  slug: string
  kind: ConnectorKind
  /** True for outbound/delivery planes (writes) — reserved cap budget. */
  isWrite: boolean
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
    key: 'salesforce',
    label: 'Salesforce',
    slug: 'salesforce',
    kind: 'nango',
    isWrite: true,
    providerId: 'nango:salesforce',
    matches: has('salesforce'),
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

// ── UI key derivation (shared with /api/integrations/available) ───────────────
const titleCase = (s: string) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

/** Nango providerConfigKey → a runtime-matchable key + display + icon slug. */
export function fromNangoProviderKey(providerConfigKey: string): { key: string; label: string; slug: string } {
  const k = providerConfigKey.toLowerCase()
  if (k.includes('slack')) return { key: 'slack', label: 'Slack', slug: 'slack' }
  if (k.includes('mail') || k.includes('gmail')) return { key: 'gmail', label: 'Gmail', slug: 'gmail' }
  if (k.includes('salesforce')) return { key: 'salesforce', label: 'Salesforce', slug: 'salesforce' }
  return { key: k, label: titleCase(k), slug: k }
}

