/**
 * Guards COPILOT_DRAFT_SCHEMA against the structured-outputs JSON Schema
 * subset the Messages API actually accepts.
 *
 * This exists because every other copilot test injects a fake `generate`, so
 * the schema itself was never exercised against the provider — a schema the
 * API rejects with 400 passed the whole suite while /api/goals/copilot/draft
 * returned 502 DRAFT_FAILED on every real request. A 400 is not an
 * availability error (see isProviderAvailabilityError), so there is no
 * fallback to mask it.
 *
 * Unsupported per the structured-outputs contract: numeric constraints
 * (minimum/maximum/multipleOf), string constraints (minLength/maxLength),
 * array constraints (minItems/maxItems/uniqueItems), recursive schemas, and
 * `additionalProperties` set to anything but false. Every object must close
 * additionalProperties — which also rules out free-form `{type:'object'}`
 * with no properties, since strictifySchema deliberately leaves those alone
 * (closing a property-less object would collapse it to an empty object).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COPILOT_DRAFT_SCHEMA } from '../copilot'
import { strictifySchema } from '@/lib/llm/model-runner'

const UNSUPPORTED_KEYWORDS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
] as const

type Finding = { path: string; problem: string }

/** Walk the schema the way the provider does and collect every violation. */
function findViolations(node: unknown, path = '$'): Finding[] {
  if (Array.isArray(node)) {
    return node.flatMap((item, index) => findViolations(item, `${path}[${index}]`))
  }
  if (!node || typeof node !== 'object') return []
  const schema = node as Record<string, unknown>
  const findings: Finding[] = []

  for (const keyword of UNSUPPORTED_KEYWORDS) {
    if (schema[keyword] !== undefined) {
      findings.push({ path, problem: `unsupported keyword "${keyword}"` })
    }
  }

  const declaresObject =
    schema.type === 'object' ||
    (Array.isArray(schema.type) && schema.type.includes('object'))
  if (declaresObject) {
    if (schema.additionalProperties !== false) {
      findings.push({
        path,
        problem: 'object does not set additionalProperties: false',
      })
    }
    if (!schema.properties || typeof schema.properties !== 'object') {
      findings.push({
        path,
        problem: 'free-form object (no properties) cannot be expressed in strict mode',
      })
    }
  }

  // A nullable union relies on `anyOf`, which IS supported; a bare
  // `type: [...]` array is not part of the documented subset.
  if (Array.isArray(schema.type)) {
    findings.push({ path, problem: `type union ${JSON.stringify(schema.type)} — use anyOf` })
  }

  // enum entries must match the declared type; a null inside a string enum
  // is the union problem in a second disguise.
  if (Array.isArray(schema.enum) && schema.enum.includes(null)) {
    findings.push({ path, problem: 'enum contains null — express nullability with anyOf' })
  }

  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    findings.push(...findViolations(value, `${path}.${key}`))
  }
  for (const key of ['items', 'anyOf', 'oneOf', 'allOf'] as const) {
    if (schema[key] !== undefined) findings.push(...findViolations(schema[key], `${path}.${key}`))
  }
  for (const key of ['definitions', '$defs'] as const) {
    for (const [name, value] of Object.entries(
      (schema[key] as Record<string, unknown>) ?? {},
    )) {
      findings.push(...findViolations(value, `${path}.${key}.${name}`))
    }
  }
  return findings
}

const format = (findings: Finding[]) =>
  findings.map((finding) => `  ${finding.path}: ${finding.problem}`).join('\n')

test('COPILOT_DRAFT_SCHEMA stays inside the structured-outputs subset', () => {
  const strictified = strictifySchema(
    COPILOT_DRAFT_SCHEMA as unknown as Record<string, unknown>,
  )
  const findings = findViolations(strictified)
  assert.deepEqual(
    findings,
    [],
    `schema would be rejected by the provider:\n${format(findings)}`,
  )
})

test('the violation walker actually detects the constructs it screens for', () => {
  // Without this, a walker that silently matched nothing would make the test
  // above pass for the wrong reason.
  const bad = {
    type: 'object',
    properties: {
      names: { type: 'array', maxItems: 4, items: { type: 'string' } },
      config: { type: 'object' },
      recurrence: { type: ['string', 'null'], enum: ['monthly', null] },
    },
    required: ['names', 'config', 'recurrence'],
    additionalProperties: false,
  }
  const problems = findViolations(strictifySchema(bad)).map((finding) => finding.problem)
  assert.ok(problems.some((problem) => problem.includes('maxItems')))
  assert.ok(problems.some((problem) => problem.includes('free-form object')))
  assert.ok(problems.some((problem) => problem.includes('type union')))
  assert.ok(problems.some((problem) => problem.includes('enum contains null')))
})
