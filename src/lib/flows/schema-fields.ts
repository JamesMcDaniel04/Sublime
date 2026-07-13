import type { FieldType, OutputField } from '@/lib/flows/graph'

export const HTTP_OUTPUT_FIELDS: readonly OutputField[] = [
  { name: 'ok', type: 'boolean', description: 'True when the HTTP response status is 2xx.' },
  { name: 'status', type: 'number', description: 'HTTP status code returned by the server.' },
  { name: 'statusText', type: 'string', description: 'HTTP status text returned by the server.' },
  { name: 'url', type: 'string', description: 'Final response URL.' },
  { name: 'headers', type: 'object', description: 'Response headers as key/value pairs.' },
  { name: 'body', type: 'any', description: 'Parsed response body when JSON is detected or requested; otherwise text.' },
  { name: 'bodyText', type: 'string', description: 'Raw response body text, truncated for flow logs.' },
]

export function httpOutputFields(): OutputField[] {
  return HTTP_OUTPUT_FIELDS.map((field) => ({ ...field }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function schemaType(value: unknown): FieldType {
  if (!isRecord(value)) return 'any'
  const raw = Array.isArray(value.type) ? value.type.find((entry) => entry !== 'null') : value.type
  if (raw === 'string' || raw === 'number' || raw === 'boolean' || raw === 'object' || raw === 'array') return raw
  if (raw === 'integer') return 'number'
  return 'any'
}

function schemaDescription(value: unknown): string | undefined {
  return isRecord(value) && typeof value.description === 'string' ? value.description : undefined
}

export function outputFieldsFromJsonSchema(schema: unknown, maxFields = 200): OutputField[] {
  if (!isRecord(schema)) return []
  const properties = isRecord(schema.properties) ? schema.properties : undefined
  if (!properties) return []
  const walk = (value: Record<string, unknown>, prefix = ''): OutputField[] => Object.entries(isRecord(value.properties) ? value.properties : {}).flatMap(([name, property]) => {
    const path = prefix ? `${prefix}.${name}` : name
    if (isRecord(property) && isRecord(property.properties)) return walk(property, path)
    return [{ name: path, type: schemaType(property), ...(schemaDescription(property) ? { description: schemaDescription(property) } : {}) }]
  })
  return walk(schema)
    .slice(0, maxFields)
    .filter((field) => field.name.trim())
}
