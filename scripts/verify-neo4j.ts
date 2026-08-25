/**
 * Prove a Neo4j instance is actually fit to serve graph-RAG.
 *
 * Run this against a NEW instance before it carries traffic, and again after
 * any credential cutover. `Neo4jGraphStore.ensureIndexes()` creates the schema
 * lazily on first driver construction with every statement swallowed by
 * `.catch(() => undefined)` — the right default, since a server that cannot
 * create a vector index (Community edition) should degrade rather than crash
 * the app. The cost is that a failed creation is SILENT: search() falls back to
 * a full org label scan scored in-process, which is correct, O(n) per query,
 * and indistinguishable from a healthy instance until latency grows with the
 * workspace. This script turns that silence into an exit code.
 *
 *   NEO4J_URI=… NEO4J_USERNAME=… NEO4J_PASSWORD=… npx tsx scripts/verify-neo4j.ts
 *
 * Exits 0 when the instance is fit, 1 when it is not. The only writes are the
 * schema statements ensureIndexes() runs — which is precisely what we verify.
 */
import { EMBEDDING_DIM } from '@/lib/rag/embeddings'
import { Neo4jGraphStore, neo4jConfigured } from '@/lib/rag/neo4j-store'
import { summarizeNeo4jSchema, type ConstraintRow, type IndexRow } from '@/lib/rag/neo4j-schema'

/**
 * Strip driver wrapper classes down to plain JS. The driver is built with
 * disableLosslessIntegers, so numerics already arrive as numbers — note that a
 * JSON round-trip does NOT convert an Integer, it yields `{low, high}`, which
 * Number() then reads as NaN. This flattens Node/Map wrappers, not integers.
 */
const plain = <T>(value: unknown): T => JSON.parse(JSON.stringify(value ?? null)) as T

async function main() {
  if (!neo4jConfigured()) {
    console.error('NEO4J_URI, NEO4J_USERNAME and NEO4J_PASSWORD must ALL be set — with any one missing the store silently falls back to the in-memory graph.')
    process.exit(1)
  }
  // Never print credentials, and userinfo can be embedded in a bolt URI.
  console.log(`Verifying ${process.env.NEO4J_URI!.replace(/\/\/[^@]*@/, '//')}\n`)

  // Constructing the store and forcing the driver runs ensureIndexes(), so this
  // provisions a fresh instance and gives us something to assert against.
  const store = new Neo4jGraphStore()
  await store.ensureReady()

  const neo4j = (await import('neo4j-driver')).default
  // disableLosslessIntegers so counts and index dimensions arrive as plain JS
  // numbers rather than {low, high} Integer objects. The schema rules normalise
  // that shape anyway, but node counts here are summed directly.
  const driver = neo4j.driver(
    process.env.NEO4J_URI!,
    neo4j.auth.basic(process.env.NEO4J_USERNAME!, process.env.NEO4J_PASSWORD!),
    { disableLosslessIntegers: true },
  )

  try {
    const rowsOf = async (query: string): Promise<Record<string, unknown>[]> =>
      (await driver.executeQuery(query)).records.map((record) => plain<Record<string, unknown>>(record.get('row')))

    const indexes = (await rowsOf(
      'SHOW INDEXES YIELD name, type, state, labelsOrTypes, properties, options ' +
        'RETURN { name: name, type: type, state: state, labelsOrTypes: labelsOrTypes, properties: properties, options: options } AS row',
    )) as unknown as IndexRow[]
    const constraints = (await rowsOf(
      'SHOW CONSTRAINTS YIELD name, type, labelsOrTypes, properties ' +
        'RETURN { name: name, type: type, labelsOrTypes: labelsOrTypes, properties: properties } AS row',
    )) as unknown as ConstraintRow[]

    const report = summarizeNeo4jSchema(indexes, constraints, EMBEDDING_DIM)

    console.log('Schema')
    console.log(
      `  vector index      ${
        report.vectorIndex.present
          ? `present (${report.vectorIndex.dimensions}d, ${report.vectorIndex.similarity}, ${report.vectorIndex.online ? 'ONLINE' : 'not online'})`
          : 'MISSING'
      }`,
    )
    console.log(`  tenant constraint ${report.tenantConstraint.present ? 'present' : 'MISSING'}`)

    // Contents, so a completed cutover can be told apart from an empty instance.
    const counts = await driver.executeQuery(
      'MATCH (e:Entity) RETURN e.organizationId AS org, e.type AS type, count(*) AS n ORDER BY org, type',
    )
    const total = counts.records.reduce((sum, record) => sum + Number(plain(record.get('n'))), 0)
    console.log(`\nContents — ${total} node(s)`)
    if (total === 0) {
      console.log('  (empty — expected on a fresh instance; seed it with scripts/run-backfill.ts)')
    } else {
      for (const record of counts.records) {
        const org = String(plain(record.get('org')) ?? 'unknown').slice(0, 8)
        const type = String(plain(record.get('type')) ?? 'unknown')
        console.log(`  ${org}…  ${type.padEnd(12)} ${Number(plain(record.get('n')))}`)
      }
    }

    if (report.problems.length > 0) {
      console.error('\nProblems')
      for (const problem of report.problems) console.error(`  ✖ ${problem}`)
    } else {
      console.log('\n✔ Instance is fit to serve graph-RAG.')
    }
    process.exitCode = report.ok ? 0 : 1
  } finally {
    await driver.close().catch(() => undefined)
    await store.close().catch(() => undefined)
  }
}

main().catch((error) => {
  console.error('VERIFY FAILED:', error)
  process.exit(1)
})
