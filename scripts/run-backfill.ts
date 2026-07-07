import { prisma } from '@/lib/prisma'
import { backfillOrganization } from '@/lib/rag/backfill'

async function main() {
  // Only orgs that have at least one user (skip empty/test shells).
  const orgs = await prisma.organization.findMany({
    where: { users: { some: {} } },
    select: { id: true, name: true, _count: { select: { agents: true, users: true } } },
  })
  console.log(`Backfilling ${orgs.length} org(s)…`)
  for (const org of orgs) {
    const result = await backfillOrganization(org.id)
    console.log(`- ${org.name} (users:${org._count.users}, agents:${org._count.agents}):`, JSON.stringify(result))
  }
  await prisma.$disconnect()
}

main().catch((e) => { console.error('BACKFILL FAILED:', e); process.exit(1) })
