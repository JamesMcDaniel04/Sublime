import { resolveSecretProviders, assertSafeSecretPath, type SecretProvider, type SecretRef } from '@/lib/secrets/providers'

/**
 * Fetching a secret from an external store.
 *
 * Kept apart from lib/secrets/providers.ts so the parsing and redaction rules
 * stay pure and testable, and so this — the part that talks to the network and
 * holds real secret values — is one small file that can be read in full.
 *
 * **Not behind the SSRF guard, deliberately.** The obvious move is
 * fetchPublicUrl, and it is wrong here: that guard refuses PRIVATE addresses,
 * and a Vault instance lives at vault.internal by design. Routing secret reads
 * through it would block the feature's main use case.
 *
 * The threat model is different. The base URL is operator configuration, as
 * trusted as DATABASE_URL — it does not come from a flow. What DOES come from
 * a flow is the PATH, so that is what is constrained: `assertSafePath` refuses
 * anything that could leave the configured base URL, which is the actual way a
 * template could aim this at somewhere it should not reach.
 */

/** Where the value lives in each store's response. */
function extractValue(kind: SecretProvider['kind'], body: unknown, path: string): string | undefined {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}

  if (kind === 'vault') {
    // KV v2 nests under data.data; KV v1 under data.
    const outer = record.data as Record<string, unknown> | undefined
    const inner = outer?.data as Record<string, unknown> | undefined
    const leaf = path.split('/').pop() ?? ''
    const source = inner ?? outer
    const direct = source?.[leaf]
    if (typeof direct === 'string') return direct
    // A single-valued secret is commonly stored under `value`.
    const fallback = source?.value
    return typeof fallback === 'string' ? fallback : undefined
  }

  if (kind === 'infisical') {
    const secret = record.secret as Record<string, unknown> | undefined
    const value = secret?.secretValue ?? record.secretValue
    return typeof value === 'string' ? value : undefined
  }

  // 1Password Connect: an item with fields, the value on the first that has one.
  const fields = record.fields
  if (Array.isArray(fields)) {
    for (const field of fields) {
      const value = (field as Record<string, unknown>)?.value
      if (typeof value === 'string' && value) return value
    }
  }
  const value = record.value
  return typeof value === 'string' ? value : undefined
}

function endpointFor(provider: SecretProvider, path: string): string {
  const base = provider.baseUrl.replace(/\/+$/, '')
  const clean = path.replace(/^\/+/, '')
  if (provider.kind === 'vault') return `${base}/v1/${clean}`
  if (provider.kind === 'infisical') return `${base}/api/v3/secrets/raw/${encodeURIComponent(clean)}`
  return `${base}/v1/vaults/${clean}`
}

function authHeaders(provider: SecretProvider, token: string): Record<string, string> {
  // Vault uses its own header; the others are bearer.
  return provider.kind === 'vault'
    ? { 'X-Vault-Token': token }
    : { authorization: `Bearer ${token}` }
}

/**
 * Resolve the secrets a run needs, once.
 *
 * Fetched per RUN rather than per reference: the same secret used in five
 * steps is one network call, and a rotation mid-run cannot make two steps
 * disagree about the value.
 *
 * A failure is thrown, not defaulted. Continuing with an empty string would
 * send an unauthenticated request somewhere and produce a confusing downstream
 * failure instead of an obvious one.
 */
export async function fetchSecrets(
  refs: SecretRef[],
  env: Record<string, string | undefined> = process.env,
): Promise<Map<string, string>> {
  const values = new Map<string, string>()
  if (refs.length === 0) return values

  const providers = new Map(resolveSecretProviders(env).map((provider) => [provider.id, provider]))

  // Deduplicate: five steps referencing one secret is one call.
  const unique = new Map(refs.map((ref) => [`${ref.provider}.${ref.path}`, ref]))

  for (const [key, ref] of unique) {
    const provider = providers.get(ref.provider)
    if (!provider) throw new Error(`No secret provider named "${ref.provider}" is configured.`)
    const token = env[provider.tokenEnv]
    if (!token) throw new Error(`Secret provider "${ref.provider}" has no token configured.`)

    assertSafeSecretPath(ref.path)
    const response = await fetch(endpointFor(provider, ref.path), {
      headers: authHeaders(provider, token),
      // A secret read that hangs must not hang the run.
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      // The status, never the body: an error body from a secret store can
      // contain the path, the token prefix, or the value itself.
      throw new Error(`Secret "${ref.provider}.${ref.path}" could not be read (HTTP ${response.status}).`)
    }
    const value = extractValue(provider.kind, await response.json().catch(() => ({})), ref.path)
    if (typeof value !== 'string') {
      throw new Error(`Secret "${ref.provider}.${ref.path}" was not found in the store's response.`)
    }
    values.set(key, value)
  }

  return values
}
