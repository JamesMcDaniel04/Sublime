/**
 * One-time tenancy repair: every user gets their OWN workspace unless invited.
 *
 *   npx tsx scripts/assign-personal-orgs.ts           # dry run (default): print the plan
 *   npx tsx scripts/assign-personal-orgs.ts --apply   # execute
 *
 * Phase A — merge duplicate auth identities. Two sign-in methods for the same
 * email created two user rows (and often two workspaces). The EARLIEST user
 * wins; every duplicate's Supabase identity becomes a user_identities link to
 * the winner, the duplicate's data (userId columns) and workspace contents
 * (organizationId columns) fold into the winner's, and the duplicate row is
 * deactivated. From then on both sign-in methods resolve to one user.
 *
 * Phase B — split shared workspaces. Orgs holding multiple distinct users
 * (the legacy everyone-in-one-org signup) keep their EARLIEST admin; every
 * other member moves to a fresh personal workspace they admin, taking their
 * owned agents/flows (and each one's dependent rows) with them. Org-level
 * shared rows (audit history, Slack workspace connections, integration
 * secrets, org Nango connections) stay put.
 *
 * Idempotent and conflict-tolerant: rows that hit unique collisions are
 * reported and left in place; re-run after resolving.
 */
import { systemPrisma } from '@/lib/prisma'

// systemPrisma: this is a cross-org data repair by definition — it re-homes
// rows BETWEEN organizations, which the tenant guard rightly forbids for
// user-facing code.
const db = systemPrisma

const APPLY = process.argv.includes('--apply')

type AnyDelegate = {
  updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }>
  count: (args: { where: Record<string, unknown> }) => Promise<number>
}
const delegate = (model: string): AnyDelegate => (db as unknown as Record<string, AnyDelegate>)[model]

/** Models whose rows belong to a user directly (scalar userId). */
const USER_OWNED = [
  'agentTask', 'flow', 'agentTemplate', 'integration', 'mcpConnection', 'nangoConnection',
  'pushSubscription', 'knowledgeDocument', 'sharedSkill', 'assistantChatSession', 'assistantChatMessage',
  'userEvent', 'userPattern', 'userSuggestion', 'notification',
] as const

/** userId columns rewritten when merging a duplicate user into the winner. */
const USER_ID_REWRITE = [
  ...USER_OWNED,
  'agentChatSession', 'agentChatMessage', 'agentExecution', 'flowComment', 'flowCollaborator', 'flowRun',
] as const

/** Every org-carrying model, for whole-org merges in Phase A. */
const ORG_MODELS = [
  'agentTask', 'agentConnector', 'agentMemory', 'agentChatMessage', 'agentChatSession', 'assistantChatSession',
  'assistantChatMessage', 'agentExecution', 'notification', 'pushSubscription', 'auditEvent', 'agentTemplate',
  'integration', 'mcpConnection', 'nangoConnection', 'integrationSecret', 'flow', 'flowComment', 'flowCollaborator',
  'flowVersion', 'flowRun', 'slackWorkspaceConnection', 'slackThreadSession', 'activityEvent', 'userEvent',
  'userPattern', 'userSuggestion', 'activityBackfill', 'knowledgeDocument', 'knowledgeChunk', 'sharedSkill',
  'organizationInvitation',
] as const

let failures = 0
// Users Phase A merges away — Phase B must not plan personal orgs for them
// (in apply mode they are already deactivated; this keeps the DRY RUN honest).
const mergedAway = new Set<string>()
async function move(model: string, where: Record<string, unknown>, data: Record<string, unknown>, label: string) {
  const count = await delegate(model).count({ where })
  if (!count) return
  if (!APPLY) {
    console.log(`    would move ${count} ${model} row(s) — ${label}`)
    return
  }
  try {
    const res = await delegate(model).updateMany({ where, data })
    console.log(`    moved ${res.count} ${model} row(s) — ${label}`)
  } catch (error) {
    failures++
    console.error(`    !! ${model} (${label}) failed — rows left in place:`, error instanceof Error ? error.message : error)
  }
}

async function mergeDuplicateUsers() {
  console.log('\n── Phase A: merge duplicate auth identities (same email, multiple users)')
  const dupes = await db.user.groupBy({
    by: ['email'], where: { isActive: true, email: { not: null } }, having: { email: { _count: { gt: 1 } } },
  })
  if (!dupes.length) return console.log('  none found')

  for (const { email } of dupes) {
    const rows = await db.user.findMany({ where: { email, isActive: true }, orderBy: { createdAt: 'asc' } })
    const winner = rows.find((row) => row.organizationId) ?? rows[0]
    const losers = rows.filter((row) => row.id !== winner.id)
    console.log(`  ${email}: keeping ${winner.id} (created ${winner.createdAt.toISOString()}), merging ${losers.length} duplicate(s)`)

    for (const loser of losers) {
      mergedAway.add(loser.id)
      if (!APPLY) { console.log(`    would link identity ${loser.supabaseId} → ${winner.id}, rewrite ownership, deactivate ${loser.id}`) }
      else {
        await db.userIdentity.upsert({
          where: { supabaseId: loser.supabaseId },
          create: { supabaseId: loser.supabaseId, userId: winner.id },
          update: { userId: winner.id },
        })
      }
      for (const model of USER_ID_REWRITE) await move(model, { userId: loser.id }, { userId: winner.id }, `owner ${loser.id}→${winner.id}`)
      await move('flowCollaborator', { invitedById: loser.id }, { invitedById: winner.id }, 'inviter rewrite')
      if (loser.organizationId && winner.organizationId && loser.organizationId !== winner.organizationId) {
        for (const model of ORG_MODELS)
          await move(model, { organizationId: loser.organizationId }, { organizationId: winner.organizationId }, `org merge ${loser.organizationId}→${winner.organizationId}`)
      }
      if (APPLY) await db.user.update({ where: { id: loser.id }, data: { isActive: false, organizationId: loser.organizationId } })
    }
  }
}

async function splitSharedOrgs() {
  console.log('\n── Phase B: give every non-invited member their own workspace')
  const orgs = await db.organization.findMany({
    where: { users: { some: { isActive: true } } },
    include: { users: { where: { isActive: true }, orderBy: { createdAt: 'asc' } } },
  })
  for (const org of orgs) org.users = org.users.filter((user) => !mergedAway.has(user.id))
  const shared = orgs.filter((org) => org.users.length > 1)
  if (!shared.length) return console.log('  none found — every active user already has their own workspace')

  for (const org of shared) {
    const keeper = org.users.find((user) => user.role === 'ADMIN') ?? org.users[0]
    const movers = org.users.filter((user) => user.id !== keeper.id)
    console.log(`  org "${org.name}" (${org.id}): keeping ${keeper.email ?? keeper.id}, moving out ${movers.length} member(s)`)

    for (const mover of movers) {
      const orgName = mover.name || (mover.email ?? 'user').split('@')[0]
      let newOrgId = '(new-org)'
      if (APPLY) {
        const newOrg = await db.organization.create({ data: { name: orgName, slug: `org-${mover.supabaseId}` } })
        newOrgId = newOrg.id
        await db.user.update({ where: { id: mover.id }, data: { organizationId: newOrg.id, role: 'ADMIN' } })
      }
      console.log(`    ${mover.email ?? mover.id} → personal workspace ${newOrgId}`)

      const scope = { organizationId: org.id }
      const dest = { organizationId: newOrgId }
      // Direct ownership first…
      for (const model of USER_OWNED) await move(model, { ...scope, userId: mover.id }, dest, `owned by ${mover.email ?? mover.id}`)
      // …then rows that follow a moved agent / flow / knowledge document.
      const agentIds = (await db.agentTask.findMany({ where: APPLY ? { organizationId: newOrgId } : { ...scope, userId: mover.id }, select: { id: true } })).map((row) => row.id)
      if (agentIds.length) {
        for (const model of ['agentConnector', 'agentExecution', 'agentChatSession', 'agentChatMessage'])
          await move(model, { ...scope, agentTaskId: { in: agentIds } }, dest, 'follows moved agent')
        await move('agentMemory', { ...scope, agentId: { in: agentIds } }, dest, 'follows moved agent')
      }
      const flowIds = (await db.flow.findMany({ where: APPLY ? { organizationId: newOrgId } : { ...scope, userId: mover.id }, select: { id: true } })).map((row) => row.id)
      if (flowIds.length)
        for (const model of ['flowVersion', 'flowRun', 'flowComment', 'flowCollaborator', 'slackThreadSession'])
          await move(model, { ...scope, flowId: { in: flowIds } }, dest, 'follows moved flow')
      const docIds = (await db.knowledgeDocument.findMany({ where: APPLY ? { organizationId: newOrgId } : { ...scope, userId: mover.id }, select: { id: true } })).map((row) => row.id)
      if (docIds.length) await move('knowledgeChunk', { ...scope, documentId: { in: docIds } }, dest, 'follows moved document')
    }
  }
}

async function main() {
  console.log(APPLY ? 'APPLY mode — executing changes' : 'DRY RUN — pass --apply to execute')
  await mergeDuplicateUsers()
  await splitSharedOrgs()
  if (failures) console.error(`\n${failures} move(s) failed on unique collisions — resolve and re-run (script is idempotent).`)
  console.log('\nDone.')
  await db.$disconnect()
}

main().catch((error) => { console.error('FAILED:', error); process.exit(1) })
