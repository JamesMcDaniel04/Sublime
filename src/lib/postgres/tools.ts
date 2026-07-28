/**
 * Postgres integration — the agent/flow tools for one connected database.
 *
 * Read tools are always offered. The write tool is offered ONLY when the
 * connection's `allowWrites` column is true, and — for agent runs — every call
 * to it pauses the run for human approval regardless of the agent's own
 * requireApproval setting (see `alwaysRequiresApproval` in the connector
 * registry). Two independent human decisions stand between a model and a
 * mutation: someone enabled writes on this database, and someone approved this
 * statement.
 *
 * Tool NAMES are load-bearing beyond readability: the intelligence scan's
 * generic sampler picks tools by regex and calls them with empty args, so
 * `query`/`execute` deliberately do not read as list/describe operations. The
 * Postgres scan uses its own sampler (`./scan`) rather than that path.
 */
import type { ToolDefinition } from '@/lib/llm/model-runner'
import type { ResolvedPostgresConnection } from './connections'
import { withReadOnlyTransaction, withWriteTransaction, type CreatePgClient } from './client'
import { validateReadOnlyQuery, validateWriteStatement } from './sql-policy'
import { describeSchema, listTables } from './introspect'

/** A result set larger than this is truncated — a wide SELECT must not blow the context window. */
export const MAX_RESULT_ROWS = 200
export const MAX_RESULT_CHARS = 100_000

export const POSTGRES_READ_TOOLS = ['list_tables', 'describe_schema', 'query'] as const
export const POSTGRES_WRITE_TOOL = 'execute'

export function postgresTools(allowWrites: boolean): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: 'list_tables',
      description:
        'List the tables, views, and materialized views in the connected Postgres database, largest first, with estimated row counts and on-disk size. Start here when you do not know the schema.',
      inputSchema: {
        type: 'object',
        properties: {
          schema: { type: 'string', description: "Schema to list (defaults to the connection's default schema)." },
        },
      },
    },
    {
      name: 'describe_schema',
      description:
        'Describe columns, types, nullability, primary keys, and foreign-key targets. Pass a table to describe one; omit it to describe the schema. Read this before writing SQL so joins and column names are correct.',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Optional table name to describe.' },
          schema: { type: 'string', description: "Schema to inspect (defaults to the connection's default schema)." },
        },
      },
    },
    {
      name: 'query',
      description:
        'Run a read-only SQL query and return the rows. Must be a single SELECT or WITH statement — no semicolons, no data or schema modification. Results are truncated at 200 rows, so aggregate or LIMIT in SQL rather than fetching everything.',
      inputSchema: {
        type: 'object',
        properties: { sql: { type: 'string', description: 'A single SELECT or WITH statement.' } },
        required: ['sql'],
      },
    },
  ]
  if (allowWrites) {
    tools.push({
      name: POSTGRES_WRITE_TOOL,
      description:
        'Run a single INSERT, UPDATE, or DELETE against the connected database and return the number of rows affected. UPDATE and DELETE must include a WHERE clause. Schema changes (CREATE/ALTER/DROP/TRUNCATE) are never permitted. This pauses the run for human approval before it executes.',
      inputSchema: {
        type: 'object',
        properties: { sql: { type: 'string', description: 'A single INSERT, UPDATE, or DELETE statement.' } },
        required: ['sql'],
      },
    })
  }
  return tools
}

/**
 * Truncate a result set two ways: by row count, and by serialized size. A
 * 50-row result of large JSONB documents can be far more context-hostile than
 * 200 narrow rows, so the char budget is checked independently.
 */
export function truncateRows(rows: Record<string, unknown>[]): {
  rows: Record<string, unknown>[]
  truncated: boolean
  totalRows: number
} {
  const totalRows = rows.length
  let kept = rows.slice(0, MAX_RESULT_ROWS)
  let truncated = kept.length < totalRows
  while (kept.length > 1 && JSON.stringify(kept).length > MAX_RESULT_CHARS) {
    kept = kept.slice(0, Math.floor(kept.length / 2))
    truncated = true
  }
  return { rows: kept, truncated, totalRows }
}

/**
 * Executes tools against ONE connected database.
 *
 * Matches the `McpToolClient` shape the tool planes expect (`executeTool`),
 * so the agent loop and the flow runtime route to it exactly as they do for
 * every other plane. The resolved connection — including the decrypted
 * connection string — stays private to the instance and never appears in a
 * returned value.
 */
export class PostgresToolClient {
  constructor(
    private readonly connection: ResolvedPostgresConnection,
    private readonly createClient?: CreatePgClient,
  ) {}

  private get params() {
    return {
      connectionString: this.connection.connectionString,
      ...(this.connection.caCert ? { caCert: this.connection.caCert } : {}),
      ...(this.createClient ? { createClient: this.createClient } : {}),
    }
  }

  async executeTool(_serverUrl: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const schema = typeof args.schema === 'string' && args.schema.trim() ? args.schema.trim() : this.connection.defaultSchema

    if (name === 'list_tables') {
      const tables = await withReadOnlyTransaction(this.params, (client) => listTables(client, schema))
      return { schema, tables }
    }

    if (name === 'describe_schema') {
      const table = typeof args.table === 'string' && args.table.trim() ? args.table.trim() : undefined
      const columns = await withReadOnlyTransaction(this.params, (client) => describeSchema(client, schema, table))
      return { schema, ...(table ? { table } : {}), columns }
    }

    if (name === 'query') {
      const sql = validateReadOnlyQuery(String(args.sql ?? ''))
      const result = await withReadOnlyTransaction(this.params, (client) => client.query(sql))
      const { rows, truncated, totalRows } = truncateRows(result.rows)
      return {
        rows,
        rowCount: rows.length,
        ...(truncated
          ? { truncated: true, note: `Returned ${rows.length} of ${totalRows} rows — narrow the query or aggregate in SQL.` }
          : {}),
      }
    }

    if (name === POSTGRES_WRITE_TOOL) {
      // Defence in depth: the tool is not even offered when allowWrites is
      // false, but a stale binding must not be able to reach a write.
      if (!this.connection.allowWrites) {
        throw new Error(
          `Writes are disabled for the "${this.connection.name}" database. Enable them in Integrations → PostgreSQL.`,
        )
      }
      const sql = validateWriteStatement(String(args.sql ?? ''))
      const result = await withWriteTransaction(this.params, (client) => client.query(sql))
      return { rowCount: result.rowCount ?? 0 }
    }

    throw new Error(`Unknown Postgres tool: ${name}`)
  }
}
