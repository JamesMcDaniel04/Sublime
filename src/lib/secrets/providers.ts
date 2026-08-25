/**
 * External secret providers — `{{secrets.<provider>.<path>}}`.
 *
 * The credential vault is good at what it does: placeholder-only reveal,
 * rotation, lifecycle audit. It is the wrong SHAPE for an organisation that
 * already runs HashiCorp Vault or 1Password and expects its automation to read
 * from there. For a larger org that is a procurement blocker, not a
 * convenience.
 *
 * **Scope is deliberate.** Vault, Infisical and 1Password Connect are HTTP APIs
 * with a token header, so they need no new dependency. AWS Secrets Manager
 * (SigV4), Azure Key Vault and GCP (OAuth exchange) need signing machinery and
 * are left out rather than half-implemented — a secret store that works
 * sometimes is worse than one that is absent.
 *
 * **The dangerous half is not fetching.** Unlike a vault credential, which is
 * injected at the transport edge and never enters the graph, a resolved secret
 * is a real value flowing through step outputs, run rows and error messages.
 * Without `redactSecrets` on the way out, using a secret store would be LESS
 * safe than the vault, not more.
 */

export const SECRETS_ROOT = 'secrets'

/** Stores reachable with a bearer-style token and no request signing. */
export const SUPPORTED_KINDS = ['vault', 'infisical', 'onepassword'] as const
export type SecretProviderKind = (typeof SUPPORTED_KINDS)[number]

export interface SecretProvider {
  id: string
  kind: SecretProviderKind
  baseUrl: string
  tokenEnv: string
}

const CONFIG_RE = /^SECRETS_PROVIDER_([A-Z0-9]+)_KIND$/

/**
 * https, or loopback for a local development store.
 *
 * Plaintext to a remote secret store would put the store's own token AND every
 * secret it returns on the wire in the clear — the single worst thing this
 * module could permit, and not a trade a config typo should be able to make.
 */
function endpointAcceptable(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
}

/**
 * Providers configured in this environment.
 *
 *   SECRETS_PROVIDER_<NAME>_KIND      vault | infisical | onepassword
 *   SECRETS_PROVIDER_<NAME>_BASE_URL
 *   SECRETS_PROVIDER_<NAME>_TOKEN
 *
 * Anything incomplete or unrecognised is REFUSED rather than registered: a
 * half-configured secret store fails at the moment a flow needs a credential,
 * which is the worst possible time to discover a typo.
 */
export function resolveSecretProviders(env: Record<string, string | undefined>): SecretProvider[] {
  const providers: SecretProvider[] = []
  for (const [key, value] of Object.entries(env)) {
    const match = CONFIG_RE.exec(key)
    if (!match) continue
    const name = match[1]
    const kind = value?.trim().toLowerCase()
    if (!kind || !SUPPORTED_KINDS.includes(kind as SecretProviderKind)) continue

    const baseUrl = env[`SECRETS_PROVIDER_${name}_BASE_URL`]?.trim()
    const tokenEnv = `SECRETS_PROVIDER_${name}_TOKEN`
    if (!baseUrl || !env[tokenEnv]?.trim()) continue
    if (!endpointAcceptable(baseUrl)) continue

    providers.push({ id: name.toLowerCase(), kind: kind as SecretProviderKind, baseUrl, tokenEnv })
  }
  return providers
}

export interface SecretRef {
  provider: string
  path: string
}

/**
 * Parse `secrets.<provider>.<path>`.
 *
 * The path keeps everything after the provider, including slashes — a Vault
 * path is `kv/data/prod/stripe`, and splitting on dots alone would mangle it.
 *
 * The bare root and a provider with no path both return null: `{{secrets}}`
 * has no sensible meaning, and resolving it to anything would be a disclosure
 * the moment a template rendered it.
 */
export function parseSecretRef(path: string): SecretRef | null {
  const trimmed = path.trim()
  if (!trimmed.startsWith(`${SECRETS_ROOT}.`)) return null
  const rest = trimmed.slice(SECRETS_ROOT.length + 1)
  const dot = rest.indexOf('.')
  if (dot <= 0) return null
  const provider = rest.slice(0, dot).trim()
  const secretPath = rest.slice(dot + 1).trim()
  if (!provider || !secretPath) return null
  return { provider, path: secretPath }
}

/** Shortest value worth scrubbing — below this a "secret" matches everywhere. */
const MIN_SCRUB_LENGTH = 6
const REDACTED = 'redacted'

/**
 * Remove resolved secret values from anything on its way out of a run.
 *
 * Applied to step outputs, persisted run rows and error messages. A value
 * shorter than MIN_SCRUB_LENGTH is ignored: scrubbing "a" would replace every
 * letter in the output with "redacted", which destroys the run record and
 * teaches people to turn redaction off.
 */
export function redactSecrets(value: unknown, secrets: string[]): unknown {
  const patterns = secrets.filter((secret) => typeof secret === 'string' && secret.trim().length >= MIN_SCRUB_LENGTH)
  if (patterns.length === 0) return value

  const scrub = (input: unknown): unknown => {
    if (typeof input === 'string') {
      return patterns.reduce((text, secret) => text.split(secret).join(REDACTED), input)
    }
    if (Array.isArray(input)) return input.map(scrub)
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([key, val]) => [key, scrub(val)]))
    }
    return input
  }
  return scrub(value)
}

/**
 * A secret path may address a secret and nothing else.
 *
 * The base URL is operator configuration, but the PATH comes from a flow
 * template — so this is the actual attack surface. `..` could climb out of the
 * store's API prefix; a scheme or a leading `//` would replace the host
 * entirely and send the store's own token to someone else's server.
 *
 * Segment-wise rather than a substring check: `my.service.key` is an ordinary
 * secret name and must not be mistaken for traversal.
 */
export function assertSafeSecretPath(path: string): void {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) {
    throw new Error('A secret path cannot contain a URL.')
  }
  if (path.split('/').includes('..')) {
    throw new Error('A secret path cannot contain "..".')
  }
}

/** `{{secrets.<provider>.<path>}}` anywhere in a serialized graph. */
const SECRET_TOKEN_RE = /\{\{\s*(secrets\.[^}\s]+?)\s*\}\}/g

/**
 * Every secret a graph references.
 *
 * Scans the SERIALIZED graph rather than walking known config fields. A token
 * can appear in any string a node author chose to template, and a field-walker
 * that knows only today's node shapes would silently miss tomorrow's — failing
 * at run time with an unresolved secret rather than at collection time.
 *
 * Deduplicated here so the fetcher makes one call per distinct secret no
 * matter how many steps reference it.
 */
export function collectSecretRefs(graph: unknown): SecretRef[] {
  const found = new Map<string, SecretRef>()
  for (const match of JSON.stringify(graph ?? null).matchAll(SECRET_TOKEN_RE)) {
    const ref = parseSecretRef(match[1])
    if (ref) found.set(`${ref.provider}.${ref.path}`, ref)
  }
  return [...found.values()]
}
