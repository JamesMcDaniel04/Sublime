/**
 * Classifies one n8n credential definition into a vault-mapping entry by its
 * ACTUAL injection recipe (the `authenticate` block), not its name. Pure so
 * it unit-tests without the n8n packages; scripts/generate-n8n-credential-map.ts
 * feeds it instances loaded from n8n-nodes-base.
 */

/** The subset of n8n's ICredentialType the classifier reads. */
export type N8nCredentialDef = {
  name: string
  displayName: string
  extends?: string[]
  authenticate?: {
    type?: string
    properties?: {
      headers?: Record<string, unknown>
      qs?: Record<string, unknown>
      auth?: Record<string, unknown>
      body?: Record<string, unknown>
    }
  }
}

export type N8nCredentialMapEntry =
  | { type: 'basic' | 'bearer' | 'oauth1' | 'oauth2'; displayName: string }
  | { type: 'apiKeyHeader'; headerName: string; displayName: string }
  | { type: 'apiKeyQuery'; queryParam: string; displayName: string }
  | { type: 'custom'; entries: { kind: 'header' | 'query'; name: string }[]; displayName: string }
  | { type: 'unsupported'; reason: string; displayName: string }

/** A name computed at runtime can't prefill a form — treat as unsupported. */
const isDynamicName = (name: string) => name.includes('{{') || name.startsWith('=')

export function classifyN8nCredential(def: N8nCredentialDef): N8nCredentialMapEntry {
  const displayName = def.displayName || def.name
  const props = def.authenticate?.properties

  if (!props) {
    if (def.extends?.some((base) => /oauth2/i.test(base))) return { type: 'oauth2', displayName }
    if (def.extends?.some((base) => /oauth1/i.test(base))) return { type: 'oauth1', displayName }
    return { type: 'unsupported', reason: 'programmatic', displayName }
  }
  if (props.body && Object.keys(props.body).length) return { type: 'unsupported', reason: 'bodyAuth', displayName }
  if (props.auth) return { type: 'basic', displayName }

  const headers = Object.keys(props.headers ?? {})
  const query = Object.keys(props.qs ?? {})
  if ([...headers, ...query].some(isDynamicName)) return { type: 'unsupported', reason: 'dynamicName', displayName }

  if (headers.length + query.length > 1) {
    return {
      type: 'custom',
      entries: [
        ...headers.map((name) => ({ kind: 'header' as const, name })),
        ...query.map((name) => ({ kind: 'query' as const, name })),
      ],
      displayName,
    }
  }
  if (query.length === 1) return { type: 'apiKeyQuery', queryParam: query[0], displayName }
  if (headers.length === 1) {
    const name = headers[0]
    const value = String((props.headers ?? {})[name] ?? '')
    if (name.toLowerCase() === 'authorization') {
      if (/^=?\s*bearer\b/i.test(value)) return { type: 'bearer', displayName }
      if (/^=?\s*basic\b/i.test(value)) return { type: 'basic', displayName }
    }
    return { type: 'apiKeyHeader', headerName: name, displayName }
  }
  return { type: 'unsupported', reason: 'emptyRecipe', displayName }
}
