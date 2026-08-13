/**
 * The single chokepoint for auditing connection LIFECYCLE — every grant,
 * re-grant, edit, and revocation of third-party access, across every plane
 * (native Google OAuth, MCP servers, Nango, Slack, Postgres).
 *
 * Why a chokepoint rather than a `recordAudit` call per route: audit coverage
 * that grows per-feature starts unaudited by default, which is how OAuth — the
 * highest-value access the product holds — ended up as the one plane with no
 * record of who granted what. Routes call `recordConnectionAudit`; new planes
 * inherit the shape instead of inventing one.
 *
 * The compliance question this exists to answer is "who granted which access to
 * which account, and when was it revoked" — so `scopes` and `accountLabel` are
 * first-class, and the detail is built by a PURE function that structurally
 * cannot carry a secret: credential-named keys are dropped by name, and
 * non-scalar values (an authConfig blob) are dropped by shape.
 */
import { recordAudit } from '@/lib/audit'
import { isCredentialKey } from '@/lib/export/redact'

/** Which access plane the connection lives on. */
export type ConnectionPlane = 'google' | 'mcp' | 'nango' | 'slack' | 'postgres'

export type ConnectionAuditAction =
  /** Access granted or re-granted (OAuth callback, connection created). */
  | 'connection.granted'
  /** Non-secret configuration of an existing connection changed. */
  | 'connection.updated'
  /** Access removed — the disconnect half of the pair an auditor reconciles. */
  | 'connection.revoked'

export type ConnectionAuditInput = {
  organizationId: string
  actorUserId: string | null
  action: ConnectionAuditAction
  plane: ConnectionPlane
  /** Provider/service key: 'google-calendar', 'slack', an MCP server name. */
  provider: string
  /** The connection row's id, so grant and revoke rows join up. */
  connectionId?: string | null
  /** WHICH account — an email, workspace, or host. Never a secret. */
  accountLabel?: string | null
  /** Granted OAuth scopes. The whole point of the row for a consent grant. */
  scopes?: readonly string[] | null
  /** Extra non-secret facts. Scalars only; credential-named keys are dropped. */
  extra?: Record<string, unknown>
  ip?: string | null
}

const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

/**
 * Build the audit `detail` for a connection event. Pure, and deliberately
 * lossy: anything it cannot prove is non-secret is dropped rather than logged.
 */
export function connectionAuditDetail(input: {
  plane: ConnectionPlane
  provider: string
  accountLabel?: string | null
  scopes?: readonly string[] | null
  extra?: Record<string, unknown>
}): Record<string, unknown> {
  const extra = Object.fromEntries(
    Object.entries(input.extra ?? {}).filter(([key, value]) => !isCredentialKey(key) && isScalar(value)),
  )
  const scopes = [...new Set((input.scopes ?? []).map((scope) => scope.trim()).filter(Boolean))].sort()
  const accountLabel = input.accountLabel?.trim()
  return {
    // Spread `extra` FIRST: a caller-supplied key must never shadow the
    // identity fields an auditor filters on.
    ...extra,
    plane: input.plane,
    provider: input.provider,
    ...(accountLabel ? { accountLabel } : {}),
    ...(scopes.length ? { scopes } : {}),
  }
}

/** Record one connection lifecycle event. Never throws (recordAudit swallows). */
export async function recordConnectionAudit(input: ConnectionAuditInput): Promise<void> {
  await recordAudit({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: input.action,
    resourceType: 'connection',
    resourceId: input.connectionId ?? null,
    tool: input.provider,
    ip: input.ip ?? null,
    detail: connectionAuditDetail(input),
  })
}
