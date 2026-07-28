import assert from 'node:assert/strict'
import test from 'node:test'
import { quoteIdentifier, validateReadOnlyQuery, validateWriteStatement } from '../sql-policy'

test('read validation accepts SELECT/WITH and trims', () => {
  assert.equal(validateReadOnlyQuery('  SELECT 42  '), 'SELECT 42')
  assert.equal(
    validateReadOnlyQuery('with v as (select 42) select * from v'),
    'with v as (select 42) select * from v',
  )
})

test('read validation rejects every shape that could modify or side-effect', () => {
  for (const query of [
    '',
    '   ',
    'UPDATE things SET x = 1',
    'DELETE FROM things',
    'SELECT 1; DROP TABLE users',
    'WITH x AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM x',
    'SELECT nextval(\'s\')',
    'SELECT pg_advisory_lock(1)',
    'SELECT dblink(\'…\', \'…\')',
    'SELECT pg_read_file(\'/etc/passwd\')',
    'EXPLAIN SELECT 1',
  ]) {
    assert.throws(() => validateReadOnlyQuery(query), `expected rejection: ${query}`)
  }
})

test('write validation accepts targeted data statements', () => {
  assert.equal(validateWriteStatement('INSERT INTO t (a) VALUES (1)'), 'INSERT INTO t (a) VALUES (1)')
  assert.equal(validateWriteStatement('UPDATE t SET a = 1 WHERE id = 2'), 'UPDATE t SET a = 1 WHERE id = 2')
  assert.equal(validateWriteStatement('delete from t where id = 2'), 'delete from t where id = 2')
})

test('write validation refuses an unqualified UPDATE or DELETE', () => {
  assert.throws(() => validateWriteStatement('UPDATE users SET plan = \'free\''), /WHERE/i)
  assert.throws(() => validateWriteStatement('DELETE FROM users'), /WHERE/i)
})

test('write validation refuses DDL and server-state verbs even when writes are enabled', () => {
  for (const statement of [
    'DROP TABLE users',
    'ALTER TABLE users ADD COLUMN x int',
    'TRUNCATE users',
    'CREATE TABLE t (a int)',
    'GRANT ALL ON users TO public',
    'SELECT 1',
    'UPDATE t SET a = 1 WHERE id = 1; DROP TABLE users',
    'INSERT INTO t SELECT * FROM dblink(\'…\', \'…\') AS x(a int)',
  ]) {
    assert.throws(() => validateWriteStatement(statement), `expected rejection: ${statement}`)
  }
})

test('semicolons are refused on both paths, which is what stops statement chaining', () => {
  assert.throws(() => validateReadOnlyQuery('SELECT 1; SELECT 2'), /single statement/i)
  assert.throws(() => validateWriteStatement('INSERT INTO t VALUES (1); DELETE FROM t'), /single statement/i)
})

test('identifier quoting rejects rather than escapes', () => {
  assert.equal(quoteIdentifier('public'), '"public"')
  assert.equal(quoteIdentifier('user_events'), '"user_events"')
  for (const identifier of ['users"; DROP TABLE x --', 'a b', '1abc', '', 'sch.ema']) {
    assert.throws(() => quoteIdentifier(identifier), `expected rejection: ${identifier}`)
  }
})
