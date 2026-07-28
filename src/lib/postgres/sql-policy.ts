/**
 * Statement-shape policy for every SQL that reaches a customer database.
 *
 * Pure functions, no I/O — this is layer 1 of the hardening. Layer 0 is
 * connection-config reduction and layer 2 is the server-enforced transaction
 * mode, both in `./client`. Each layer is independently sufficient for the
 * read path; the denylist exists so a bad statement is refused with a clear
 * message rather than failing opaquely inside a READ ONLY transaction.
 */

const STATEMENT_LIMIT = 10_000

/**
 * Read path. Single statement, SELECT/WITH only, and a word-boundary denylist
 * so a data-modifying CTE (`WITH x AS (UPDATE …) SELECT …`) or a SELECT-shaped
 * side effect (nextval, advisory locks, dblink) cannot ride in under a SELECT
 * prefix. Column names like `updated_at` do not trip the boundary match; a
 * column literally named `delete` is a false positive we accept — the error
 * says why.
 */
const FORBIDDEN_READ_KEYWORDS =
  /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|copy|vacuum|call|do|set|reset|lock|listen|notify|unlisten|refresh|reindex|cluster|comment|security|nextval|setval|lo_import|lo_export|dblink|dblink_exec|pg_advisory_lock|pg_advisory_xact_lock|pg_terminate_backend|pg_cancel_backend|pg_read_file|pg_write_file|pg_ls_dir)\b/i

/**
 * Write path. "Allow writes" means ROWS, never SCHEMA — DDL and admin verbs
 * stay forbidden even on a connection whose owner enabled writes, because
 * nothing an agent legitimately does requires dropping a table. Sequence
 * functions are absent from this list (unlike the read one): `nextval` in an
 * INSERT is ordinary, and we are already in a write context.
 */
const FORBIDDEN_WRITE_KEYWORDS =
  /\b(truncate|drop|alter|create|grant|revoke|copy|vacuum|call|do|reset|listen|notify|unlisten|refresh|reindex|cluster|comment|security|lo_import|lo_export|dblink|dblink_exec|pg_advisory_lock|pg_advisory_xact_lock|pg_terminate_backend|pg_cancel_backend|pg_read_file|pg_write_file|pg_ls_dir)\b/i

/** Shared shape checks: non-empty, bounded, exactly one statement. */
function normalizeStatement(sql: string, label: string): string {
  const trimmed = sql.trim()
  if (!trimmed) throw new Error(`${label} cannot be empty.`)
  if (trimmed.length > STATEMENT_LIMIT) {
    throw new Error(`${label} must be ${STATEMENT_LIMIT.toLocaleString()} characters or fewer.`)
  }
  // Rejecting semicolons outright is what makes statement chaining impossible,
  // including through a value interpolated into a flow node's configured SQL.
  if (trimmed.includes(';')) {
    throw new Error(`${label} must be a single statement without semicolons.`)
  }
  return trimmed
}

export function validateReadOnlyQuery(query: string): string {
  const trimmed = normalizeStatement(query, 'Postgres query')
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new Error('Postgres query must start with SELECT or WITH.')
  }
  const forbidden = trimmed.match(FORBIDDEN_READ_KEYWORDS)
  if (forbidden) {
    throw new Error(
      `Postgres queries here are read-only — '${forbidden[0].toUpperCase()}' is not allowed.`,
    )
  }
  return trimmed
}

/**
 * Write path validation. Callers MUST have already confirmed the connection's
 * `allowWrites` column; this function only judges the statement.
 *
 * The WHERE requirement is the guard against `DELETE FROM users`. It is a
 * shape check, not a semantic one: `WHERE true` satisfies it, and a WHERE
 * appearing inside a string literal would too. That is acceptable because it
 * exists to stop the ACCIDENTAL unqualified statement — the deliberate one is
 * caught by the human approval that every agent-initiated write must pass.
 */
export function validateWriteStatement(sql: string): string {
  const trimmed = normalizeStatement(sql, 'Postgres statement')
  const verb = trimmed.match(/^(insert|update|delete)\b/i)
  if (!verb) {
    throw new Error(
      'Postgres writes must start with INSERT, UPDATE, or DELETE. Schema changes (CREATE/ALTER/DROP) are never permitted.',
    )
  }
  const forbidden = trimmed.match(FORBIDDEN_WRITE_KEYWORDS)
  if (forbidden) {
    throw new Error(
      `'${forbidden[0].toUpperCase()}' is not allowed — writes may change rows, never schema or server state.`,
    )
  }
  const isTargeted = /^insert\b/i.test(trimmed) || /\bwhere\b/i.test(trimmed)
  if (!isTargeted) {
    throw new Error(
      `${verb[0].toUpperCase()} without a WHERE clause would affect every row — add a WHERE clause.`,
    )
  }
  return trimmed
}

/**
 * A Postgres identifier (schema, table, column) safe to interpolate into an
 * introspection query. Everything user- or model-supplied that cannot be a
 * bound parameter goes through here: `information_schema` lookups take
 * parameters, but `SELECT * FROM "schema"."table"` cannot.
 *
 * Rejects rather than escapes, so an odd identifier surfaces as a clear error
 * instead of silently becoming a different table.
 */
export function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(identifier)) {
    throw new Error(
      `'${identifier}' is not a supported Postgres identifier — letters, digits, and underscores only.`,
    )
  }
  return `"${identifier}"`
}
