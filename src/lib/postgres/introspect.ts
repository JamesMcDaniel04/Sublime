/**
 * Schema introspection and bounded row sampling.
 *
 * Every query in this module is authored here and parameterized — none of it
 * is user- or model-supplied SQL, so it does not pass through the statement
 * denylist. The one place an identifier must be interpolated (a sampled
 * table's name, which cannot be a bind parameter) goes through
 * `quoteIdentifier`, which rejects rather than escapes.
 *
 * Callers run these inside `withReadOnlyTransaction`, so even a mistake here
 * cannot modify a customer database.
 */
import type { PgClient } from './client'
import { quoteIdentifier } from './sql-policy'

export const MAX_TABLES = 200
export const MAX_DESCRIBED_TABLES = 40
export const MAX_SAMPLE_TABLES = 8
export const MAX_SAMPLE_ROWS = 3

export type TableSummary = {
  schema: string
  table: string
  kind: string
  estimatedRows: number
  bytes: number
}

export type ColumnSummary = {
  table: string
  column: string
  type: string
  nullable: boolean
  isPrimaryKey: boolean
  references?: string
}

/**
 * Tables, views, and materialized views in one schema, largest first.
 *
 * Uses `pg_class.reltuples` (the planner's estimate, maintained by ANALYZE)
 * rather than COUNT(*) — an exact count on a large table would blow the
 * statement timeout, and an estimate is all that "which tables matter here?"
 * needs. A never-analyzed table reports -1, which normalizes to 0.
 */
export async function listTables(client: PgClient, schema: string, limit = MAX_TABLES): Promise<TableSummary[]> {
  const result = await client.query(
    `SELECT n.nspname AS schema,
            c.relname AS table,
            c.relkind AS kind,
            c.reltuples::bigint AS estimated_rows,
            pg_total_relation_size(c.oid) AS bytes
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm')
        AND n.nspname = $1
      ORDER BY c.reltuples DESC, c.relname ASC
      LIMIT $2`,
    [schema, limit],
  )
  return result.rows.map((row) => ({
    schema: String(row.schema),
    table: String(row.table),
    kind: KIND_LABELS[String(row.kind)] ?? String(row.kind),
    estimatedRows: Math.max(0, Number(row.estimated_rows ?? 0)),
    bytes: Number(row.bytes ?? 0),
  }))
}

const KIND_LABELS: Record<string, string> = {
  r: 'table',
  p: 'partitioned table',
  v: 'view',
  m: 'materialized view',
}

/**
 * Columns for one table, or for every table in the schema when `table` is
 * omitted (capped — an agent that asks to describe a 900-table warehouse
 * should get a useful prefix, not a timeout).
 *
 * Primary keys and foreign-key targets come from a second pass so the model
 * can see how tables join, which is most of what makes generated SQL correct.
 */
export async function describeSchema(
  client: PgClient,
  schema: string,
  table?: string,
): Promise<ColumnSummary[]> {
  const columns = await client.query(
    `SELECT c.table_name, c.column_name, c.data_type, c.is_nullable
       FROM information_schema.columns c
      WHERE c.table_schema = $1
        AND ($2::text IS NULL OR c.table_name = $2)
        AND c.table_name IN (
          SELECT table_name FROM information_schema.tables
           WHERE table_schema = $1
           ORDER BY table_name
           LIMIT $3
        )
      ORDER BY c.table_name, c.ordinal_position`,
    [schema, table ?? null, MAX_DESCRIBED_TABLES],
  )

  const constraints = await client.query(
    `SELECT tc.table_name,
            tc.constraint_type,
            kcu.column_name,
            ccu.table_name AS foreign_table,
            ccu.column_name AS foreign_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
        AND kcu.table_schema = tc.table_schema
       LEFT JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.table_schema = $1
        AND ($2::text IS NULL OR tc.table_name = $2)
        AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')`,
    [schema, table ?? null],
  )

  const primaryKeys = new Set<string>()
  const references = new Map<string, string>()
  for (const row of constraints.rows) {
    const key = `${row.table_name}.${row.column_name}`
    if (row.constraint_type === 'PRIMARY KEY') primaryKeys.add(key)
    else if (row.foreign_table) references.set(key, `${row.foreign_table}.${row.foreign_column}`)
  }

  return columns.rows.map((row) => {
    const key = `${row.table_name}.${row.column_name}`
    const target = references.get(key)
    return {
      table: String(row.table_name),
      column: String(row.column_name),
      type: String(row.data_type),
      nullable: row.is_nullable === 'YES',
      isPrimaryKey: primaryKeys.has(key),
      ...(target ? { references: target } : {}),
    }
  })
}

/**
 * A few rows from one table. Used only by the intelligence scan, which the org
 * can switch off per connection with the Learning toggle.
 *
 * The table name cannot be a bind parameter, so it is validated and quoted —
 * and it never comes from a model, only from `listTables` output.
 */
export async function sampleRows(
  client: PgClient,
  schema: string,
  table: string,
  limit = MAX_SAMPLE_ROWS,
): Promise<Record<string, unknown>[]> {
  const result = await client.query(
    `SELECT * FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)} LIMIT ${Math.max(1, Math.min(limit, MAX_SAMPLE_ROWS))}`,
  )
  return result.rows
}
