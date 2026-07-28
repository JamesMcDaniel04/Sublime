/**
 * Intelligence-scan sampler for a connected Postgres database.
 *
 * The generic scan path picks read-looking tools by regex and calls each with
 * EMPTY ARGS. That works for a Slack or Gmail plane, where "list recent items"
 * is a zero-argument call — it cannot work here, because the useful read tool
 * (`query`) requires SQL. So Postgres brings its own sampler: a fixed,
 * authored sequence of introspection queries plus a bounded row sample, all
 * inside the same READ ONLY transaction every other read path uses.
 *
 * PRIVACY: this samples real rows, so real customer values reach the summary
 * model. Three things bound that, and they are the reason it is acceptable:
 *   - MAX_SAMPLE_TABLES × MAX_SAMPLE_ROWS is a hard cap (a few dozen rows).
 *   - The distillation prompt forbids quoting record contents verbatim, so the
 *     PERSISTED profile describes shapes, not values.
 *   - An org can switch it off per database with the Learning toggle, which is
 *     checked by the caller before this runs.
 */
import { withReadOnlyTransaction } from './client'
import { resolvePostgresConnection } from './connections'
import { describeSchema, listTables, sampleRows, MAX_SAMPLE_TABLES } from './introspect'

/** Shaped for connection-scan's sample list: a label plus a serializable result. */
export type ScanSample = { tool: string; result: unknown }

/**
 * Introspect the schema, then sample a few rows from the largest tables.
 *
 * Sampling the LARGEST tables (listTables is ordered by estimated row count)
 * is what makes a scan of a 400-table warehouse useful: the tables carrying
 * the org's actual business volume lead, and the long tail of lookup and join
 * tables never crowds them out of the cap.
 */
export async function collectPostgresSamples(
  organizationId: string,
  connectionId: string,
): Promise<ScanSample[]> {
  const connection = await resolvePostgresConnection(organizationId, connectionId)
  const schema = connection.defaultSchema
  return withReadOnlyTransaction(
    {
      connectionString: connection.connectionString,
      ...(connection.caCert ? { caCert: connection.caCert } : {}),
    },
    async (client) => {
      const tables = await listTables(client, schema)
      if (tables.length === 0) return []

      const samples: ScanSample[] = [
        { tool: 'list_tables', result: { schema, tables } },
        { tool: 'describe_schema', result: { schema, columns: await describeSchema(client, schema) } },
      ]

      // Views and materialized views are skipped: sampling one can execute an
      // arbitrarily expensive definition, and its shape is already visible in
      // the column listing above.
      const sampleable = tables.filter((table) => table.kind === 'table' || table.kind === 'partitioned table')
      for (const table of sampleable.slice(0, MAX_SAMPLE_TABLES)) {
        try {
          samples.push({
            tool: `sample:${table.table}`,
            result: await sampleRows(client, schema, table.table),
          })
        } catch {
          // A table the connection's role cannot read (or an identifier the
          // policy rejects) is skipped — a permission gap on one table must
          // not lose the schema profile for the whole database.
        }
      }
      return samples
    },
  )
}
