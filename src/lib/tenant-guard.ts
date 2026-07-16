/**
 * Tenant-isolation guardrail for the shared Prisma client.
 *
 * Every read/update/delete on an org-carrying model must scope by
 * organizationId — this codebase's oldest invariant, previously enforced
 * only by convention. The guard turns a silently-unscoped query (a
 * cross-tenant data leak waiting to happen) into a loud error at the call
 * site. It is a guardrail, not a security boundary: Postgres RLS remains
 * the eventual structural fix.
 *
 * Legitimate org-less system paths (cron sweeps, reapers, tenant
 * resolution, worker-internal id-keyed writes) use `systemPrisma` from
 * src/lib/prisma.ts, with a one-line justification comment at each site.
 *
 * Known limitations (accepted for a guardrail): the check is satisfied by an
 * organizationId key ANYWHERE in the where tree — a bare branch inside OR, or
 * NOT: { organizationId }, still passes despite matching cross-tenant rows;
 * nested writes issued through a parent operation (e.g. organization.update
 * with nested child writes) are not seen by the extension; $queryRaw/$executeRaw
 * are client-level and unguarded. These are deliberate-query shapes, not
 * accidental omissions — RLS remains the structural fix.
 */

import { Prisma } from '@prisma/client'

// Org-carrying models with a REQUIRED organizationId, DERIVED from the Prisma
// schema (DMMF) so the guard can never silently drift when a model is added.
// The derivation naturally excludes User (nullable orgId, auth bootstrap),
// Organization (the tenant row itself), and transitively-scoped children
// (WorkflowStep, FlowRunStep, ExecutionMessage, WorkflowEvent) — none of them
// carry a required organizationId column; scope children via relation filters
// when querying from user-facing code.
export const ORG_SCOPED_MODELS: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models
    .filter((model) =>
      model.fields.some(
        (field) => field.name === 'organizationId' && field.kind === 'scalar' && field.isRequired && !field.isList,
      ),
    )
    .map((model) => model.name),
)

const GUARDED_OPERATIONS = new Set([
  'findFirst', 'findFirstOrThrow', 'findMany', 'findUnique', 'findUniqueOrThrow',
  'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany', 'count', 'aggregate', 'groupBy',
])

/** True when an `organizationId` key appears anywhere in the where tree with a defined value. */
export function whereHasOrgScope(where: unknown): boolean {
  if (!where || typeof where !== 'object') return false
  if (Array.isArray(where)) return where.some(whereHasOrgScope)
  for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
    if (key === 'organizationId' && value !== undefined) return true
    if (whereHasOrgScope(value)) return true
  }
  return false
}

export function assertOrgScoped(model: string, operation: string, args: unknown): void {
  if (!ORG_SCOPED_MODELS.has(model)) return
  if (!GUARDED_OPERATIONS.has(operation)) return
  const where = (args as { where?: unknown } | undefined)?.where
  if (whereHasOrgScope(where)) return
  throw new Error(
    `Tenant guard: ${model}.${operation} ran without organizationId in its where clause. ` +
      `Scope the query (add organizationId, or a relation filter that carries it), ` +
      `or — for a legitimate system-wide path — use systemPrisma from '@/lib/prisma' with a justification comment.`,
  )
}
