export type FlowHttpConfig = {
  connectionId?: unknown
  method?: unknown
  url?: unknown
  /** The author-written URL template (pre-resolution). Carried so connection
   *  auth can require a literal origin — see assertLiteralOriginForConnectionAuth. */
  urlTemplate?: unknown
  query?: unknown
  sendQuery?: unknown
  headers?: unknown
  sendHeaders?: unknown
  auth?: unknown
  queryArrayFormat?: unknown
  body?: unknown
  sendBody?: unknown
  bodyMode?: unknown
  bodyContentType?: unknown
  graphqlVariables?: unknown
  responseType?: unknown
  failOnHttpError?: unknown
  retries?: unknown
  timeoutMs?: unknown
  cookie?: unknown
  followRedirects?: unknown
  maxRedirects?: unknown
}

export type FlowHttpOutput = {
  ok: boolean
  status: number
  statusText: string
  url: string
  headers: Record<string, string>
  body: unknown
  bodyText: string
}

// fetch forbids a body on GET/HEAD (undici throws); every other method may
// carry one. n8n shows the Send Body toggle on all methods, so rather than
// dropping a configured body silently we send it wherever fetch allows and
// raise a named error where it doesn't.
const BODYLESS_METHODS = new Set(['GET', 'HEAD'])
/** What a raw body declares when the editor's Content-Type field is left alone. */
export const RAW_BODY_CONTENT_TYPE = 'text/plain'
const JSON_RE = /^(?:\{|\[|true|false|null|-?\d|")/

/**
 * Parse a request URL, naming the field on failure. `new URL` throws a bare
 * `Invalid URL`, which surfaces in a run's error with no clue which of the
 * step's fields is wrong — especially confusing when the URL came from a
 * token that resolved to '' or to a schemeless host.
 */
function requestUrl(value: string): URL {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('URL is required — set the step’s URL field.')
  try {
    return new URL(trimmed)
  } catch {
    throw new Error(`“${trimmed}” is not a valid URL — include the scheme, e.g. https://api.example.com/path.`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function parseObjectInput(value: unknown, label: string): Record<string, unknown> {
  if (value == null || value === '') return {}
  if (isRecord(value)) return value
  if (typeof value !== 'string') throw new Error(`${label} must be a JSON object.`)
  try {
    const parsed = JSON.parse(value)
    if (isRecord(parsed)) return parsed
  } catch {
    /* throw below */
  }
  throw new Error(`${label} must be a JSON object.`)
}

function stringifyHeaderValue(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function headersFrom(value: unknown): Record<string, string> {
  const parsed = parseObjectInput(value, 'Headers')
  return Object.fromEntries(
    Object.entries(parsed)
      .map(([key, item]) => [key, stringifyHeaderValue(item)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[0].trim()) && entry[1] !== undefined),
  )
}

export type QueryArrayFormat = 'repeat' | 'brackets' | 'indices' | 'comma'

function queryArrayFormatFrom(value: unknown): QueryArrayFormat {
  return value === 'brackets' || value === 'indices' || value === 'comma' ? value : 'repeat'
}

function queryUrl(url: string, query: unknown, arrayFormat: QueryArrayFormat = 'repeat'): string {
  const params = parseObjectInput(query, 'Query params')
  if (!Object.keys(params).length) return url
  const next = requestUrl(url)
  for (const [key, value] of Object.entries(params)) {
    if (!key.trim() || value == null || value === '') continue
    if (Array.isArray(value)) {
      const items = value.filter((item) => item != null && item !== '')
      if (arrayFormat === 'comma') {
        if (items.length) next.searchParams.set(key, items.map(String).join(','))
        continue
      }
      items.forEach((item, index) => {
        const name = arrayFormat === 'brackets' ? `${key}[]` : arrayFormat === 'indices' ? `${key}[${index}]` : key
        next.searchParams.append(name, String(item))
      })
      continue
    }
    next.searchParams.set(key, String(value))
  }
  return next.toString()
}

// ── Generic auth option (n8n-style "generic credentials") ───────────────────
// Explicit user-supplied headers/params always win over the auth option, the
// same precedence connection-token injection follows.

type HttpAuthOption = {
  type: 'basic' | 'bearer' | 'header' | 'query'
  username?: string
  password?: string
  token?: string
  name?: string
  value?: string
}

function parseAuthOption(value: unknown): HttpAuthOption | undefined {
  if (!isRecord(value)) return undefined
  const type = String(value.type ?? '')
  if (type !== 'basic' && type !== 'bearer' && type !== 'header' && type !== 'query') return undefined
  return value as HttpAuthOption
}

function applyAuthHeaders(headers: Record<string, string>, auth: HttpAuthOption | undefined): Record<string, string> {
  if (!auth) return headers
  if (auth.type === 'basic') {
    const credential = Buffer.from(`${auth.username ?? ''}:${auth.password ?? ''}`).toString('base64')
    return withAuthorizationValue(headers, `Basic ${credential}`)
  }
  if (auth.type === 'bearer') return withAuthorizationValue(headers, `Bearer ${auth.token ?? ''}`)
  if (auth.type === 'header') {
    const name = (auth.name ?? '').trim()
    const value = auth.value ?? ''
    if (!name || !value) return headers
    if (Object.keys(headers).some((key) => key.trim().toLowerCase() === name.toLowerCase())) return headers
    return { ...headers, [name]: value }
  }
  return headers
}

function applyAuthQuery(url: string, auth: HttpAuthOption | undefined): string {
  if (!auth || auth.type !== 'query') return url
  const name = (auth.name ?? '').trim()
  if (!name || !auth.value) return url
  const next = new URL(url)
  if (next.searchParams.has(name)) return url
  next.searchParams.append(name, auth.value)
  return next.toString()
}

function explicitBodyMode(value: unknown): 'json' | 'text' | 'raw' | 'graphql' | 'formUrlencoded' | 'multipart' | 'binary' | 'none' | undefined {
  return ['json', 'text', 'raw', 'graphql', 'formUrlencoded', 'multipart', 'binary', 'none'].includes(String(value)) ? value as 'json' | 'text' | 'raw' | 'graphql' | 'formUrlencoded' | 'multipart' | 'binary' | 'none' : undefined
}

function inferBodyMode(body: unknown): 'json' | 'text' | 'none' {
  if (body == null || body === '') return 'none'
  if (typeof body !== 'string') return 'json'
  return JSON_RE.test(body.trim()) ? 'json' : 'text'
}

function jsonBody(body: unknown): string | undefined {
  if (body == null || body === '') return undefined
  if (typeof body === 'string') {
    const trimmed = body.trim()
    if (!trimmed) return undefined
    try {
      return JSON.stringify(JSON.parse(trimmed))
    } catch {
      throw new Error('HTTP body is not valid JSON after template substitution.')
    }
  }
  return JSON.stringify(body)
}

function textBody(body: unknown): string | undefined {
  if (body == null) return undefined
  return typeof body === 'string' ? body : JSON.stringify(body)
}

export function prepareHttpRequest(config: FlowHttpConfig): {
  url: string
  init: RequestInit
  timeoutMs: number
  failOnHttpError: boolean
  responseType: 'auto' | 'json' | 'text' | 'binary'
  followRedirects: boolean
  maxRedirects: number
  runtimeAuth?: RuntimeCredentialAuth
  /**
   * Header names a vault credential contributed. Set by whoever applies the
   * injection plan; read ONLY to strip them on an off-origin redirect, since
   * a credential may use any header name.
   */
  credentialHeaders?: string[]
} {
  const method = String(config.method || 'POST').toUpperCase()
  const auth = parseAuthOption(config.auth)
  const query = config.sendQuery === false ? undefined : config.query
  const headerInput = config.sendHeaders === false ? undefined : config.headers
  const url = applyAuthQuery(queryUrl(String(config.url || ''), query, queryArrayFormatFrom(config.queryArrayFormat)), auth)
  const headers = applyAuthHeaders(headersFrom(headerInput), auth)
  // The Cookie field is a convenience for the common single-header case; an
  // explicit Cookie among `headers` always wins.
  if (typeof config.cookie === 'string' && config.cookie.trim() !== '' && !Object.keys(headers).some((key) => key.toLowerCase() === 'cookie')) {
    headers.cookie = config.cookie
  }
  const explicitMode = explicitBodyMode(config.bodyMode)
  const mode = explicitMode ?? inferBodyMode(config.body)
  const bodyless = BODYLESS_METHODS.has(method)
  // Only an explicit "Send Body" complains. A body left behind by switching
  // the method back to GET is still dropped quietly — the user turned the
  // toggle off (or never turned it on), so there is nothing to warn about.
  if (bodyless && config.sendBody === true && mode !== 'none' && config.body != null && config.body !== '') {
    throw new Error(`${method} requests cannot send a body. Switch the method to POST, or turn Send Body off.`)
  }
  const bodyAllowed = !bodyless && config.sendBody !== false
  let body: BodyInit | undefined
  if (bodyAllowed && mode !== 'none') {
    if (mode === 'json') body = jsonBody(config.body)
    else if (mode === 'graphql') {
      const queryText = typeof config.body === 'string' ? config.body : String(config.body ?? '')
      if (!queryText.trim()) throw new Error('GraphQL query is required.')
      const variables = parseObjectInput(config.graphqlVariables, 'GraphQL variables')
      body = JSON.stringify({ query: queryText, variables })
    }
    else if (mode === 'formUrlencoded') {
      const values = parseObjectInput(config.body, 'Form body')
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(values)) {
        if (Array.isArray(value)) value.forEach((item) => params.append(key, String(item)))
        else params.set(key, String(value ?? ''))
      }
      body = params
    } else if (mode === 'multipart') {
      const values = parseObjectInput(config.body, 'Multipart body')
      const form = new FormData()
      for (const [key, value] of Object.entries(values)) form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''))
      body = form
    } else if (mode === 'binary') body = Buffer.from(String(config.body ?? ''), 'base64')
    else body = textBody(config.body)
    if ((mode === 'json' || mode === 'graphql') && body && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json'
    }
    if (mode === 'formUrlencoded' && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) headers['content-type'] = 'application/x-www-form-urlencoded'
    // A raw body always declares a Content-Type. The editor shows `text/plain`
    // as the default, so send exactly that when the field is left untouched —
    // otherwise the panel advertises a header the request never carries.
    // Only 'raw' defaults: 'text' is the legacy mode the retired Advanced panel
    // wrote, and existing flows using it must keep going out header-less.
    if ((mode === 'raw' || mode === 'text') && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
      const declared = typeof config.bodyContentType === 'string' ? config.bodyContentType.trim() : ''
      if (declared) headers['content-type'] = declared
      else if (mode === 'raw') headers['content-type'] = RAW_BODY_CONTENT_TYPE
    }
  }
  const timeoutMs = typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs)
    ? Math.max(1000, Math.min(120000, Math.round(config.timeoutMs)))
    : 30_000
  const responseType = config.responseType === 'json' || config.responseType === 'text' || config.responseType === 'binary' ? config.responseType : 'auto'
  return {
    url,
    init: { method, headers, ...(body !== undefined ? { body } : {}), redirect: 'manual' },
    timeoutMs,
    failOnHttpError: config.failOnHttpError !== false,
    responseType,
    followRedirects: config.followRedirects === true,
    maxRedirects: typeof config.maxRedirects === 'number' ? Math.max(0, Math.min(10, Math.round(config.maxRedirects))) : 3,
  }
}

export type PreparedHttpRequest = ReturnType<typeof prepareHttpRequest>

export type FlowHttpPaginatedOutput = { ok: true; pages: unknown[]; pageCount: number }

/**
 * Request-sequence policy: options that shape the fetch loop rather than a
 * single request — retry-on-status, pagination, and batch throttling. Values
 * arrive untyped from the interpreted node config.
 */
export type HttpRequestPolicy = {
  retryStatusCodes?: unknown
  pagination?: unknown
  batch?: unknown
}

export type HttpRequestDeps = {
  fetchImpl?: typeof fetch
  /** SSRF guard, re-run on every page, retry attempt, and redirect hop. */
  assertUrlAllowed?: (url: string) => Promise<void>
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
  maxResponseChars?: number
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const oauthEncode = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)

/**
 * The RFC 5849 §3.4.1 signature base string.
 *
 * Two details matter and both were wrong before: an
 * `application/x-www-form-urlencoded` body's params are part of the signature
 * (§3.4.1.3.1) — omitting them yields signatures every OAuth1 provider
 * rejects on POST — and the parameter sort is by BYTE order, not locale
 * collation, which reorders punctuation like `c%40` vs `c2`.
 */
export function oauth1SignatureBase(
  method: string,
  urlValue: string,
  oauthParams: Record<string, string>,
  bodyParams: Array<[string, string]> = [],
): string {
  const url = requestUrl(urlValue)
  const pairs: Array<[string, string]> = []
  url.searchParams.forEach((value, key) => pairs.push([key, value]))
  bodyParams.forEach(([key, value]) => pairs.push([key, value]))
  Object.entries(oauthParams).forEach(([key, value]) => pairs.push([key, value]))
  const byBytes = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  pairs.sort(([aKey, aValue], [bKey, bValue]) =>
    byBytes(oauthEncode(aKey), oauthEncode(bKey)) || byBytes(oauthEncode(aValue), oauthEncode(bValue)))
  const normalized = pairs.map(([key, value]) => `${oauthEncode(key)}=${oauthEncode(value)}`).join('&')
  const baseUrl = `${url.protocol}//${url.host}${url.pathname}`
  return [method.toUpperCase(), oauthEncode(baseUrl), oauthEncode(normalized)].join('&')
}

/**
 * Form params that belong in the signature base. Only a urlencoded body
 * qualifies — JSON, multipart, and raw bodies are signed by URL alone.
 */
function oauth1BodyParams(init: RequestInit): Array<[string, string]> {
  const contentType = new Headers(init.headers).get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/x-www-form-urlencoded')) return []
  const source = init.body instanceof URLSearchParams
    ? init.body
    : typeof init.body === 'string' ? new URLSearchParams(init.body) : null
  if (!source) return []
  const params: Array<[string, string]> = []
  source.forEach((value, key) => params.push([key, value]))
  return params
}

function oauth1Authorization(
  urlValue: string,
  method: string,
  auth: Extract<RuntimeCredentialAuth, { type: 'oauth1' }>,
  init: RequestInit,
) {
  const oauth: Record<string, string> = {
    oauth_consumer_key: auth.consumerKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: auth.signatureMethod,
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: auth.accessToken,
    oauth_version: '1.0',
  }
  const base = oauth1SignatureBase(method, urlValue, oauth, oauth1BodyParams(init))
  const key = `${oauthEncode(auth.consumerSecret)}&${oauthEncode(auth.tokenSecret)}`
  const algorithm = auth.signatureMethod === 'HMAC-SHA1' ? 'sha1' : 'sha256'
  oauth.oauth_signature = createHmac(algorithm, key).update(base).digest('base64')
  return `OAuth ${Object.entries(oauth).map(([name, value]) => `${oauthEncode(name)}="${oauthEncode(value)}"`).join(', ')}`
}

function digestChallenge(header: string): Record<string, string> | null {
  if (!/^\s*Digest\s+/i.test(header)) return null
  const values: Record<string, string> = {}
  const source = header.replace(/^\s*Digest\s+/i, '')
  const expression = /([a-z0-9_-]+)\s*=\s*(?:"((?:\\.|[^"])*)"|([^,\s]+))/gi
  for (const match of source.matchAll(expression)) values[match[1].toLowerCase()] = (match[2] ?? match[3] ?? '').replace(/\\"/g, '"')
  return values.realm && values.nonce ? values : null
}

function digestAuthorization(
  urlValue: string,
  method: string,
  auth: Extract<RuntimeCredentialAuth, { type: 'digest' }>,
  challenge: Record<string, string>,
) {
  const algorithmName = challenge.algorithm?.toUpperCase() ?? 'MD5'
  const hashName = algorithmName.startsWith('SHA-256') ? 'sha256' : 'md5'
  const hash = (value: string) => createHash(hashName).update(value).digest('hex')
  const uri = `${new URL(urlValue).pathname}${new URL(urlValue).search}`
  const cnonce = randomBytes(12).toString('hex')
  const nc = '00000001'
  let ha1 = hash(`${auth.username}:${challenge.realm}:${auth.password}`)
  if (algorithmName.endsWith('-SESS')) ha1 = hash(`${ha1}:${challenge.nonce}:${cnonce}`)
  const ha2 = hash(`${method.toUpperCase()}:${uri}`)
  const offeredQop = (challenge.qop ?? '').split(',').map((value) => value.trim()).filter(Boolean)
  const qop = offeredQop.includes('auth') ? 'auth' : undefined
  const response = qop
    ? hash(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : hash(`${ha1}:${challenge.nonce}:${ha2}`)
  const fields: Array<[string, string, boolean]> = [
    ['username', auth.username, true],
    ['realm', challenge.realm, true],
    ['nonce', challenge.nonce, true],
    ['uri', uri, true],
    ['response', response, true],
    ['algorithm', algorithmName, false],
  ]
  if (challenge.opaque) fields.push(['opaque', challenge.opaque, true])
  if (qop) fields.push(['qop', qop, false], ['nc', nc, false], ['cnonce', cnonce, true])
  return `Digest ${fields.map(([name, value, quoted]) => `${name}=${quoted ? `"${value.replace(/"/g, '\\"')}"` : value}`).join(', ')}`
}

/**
 * `onFetch` fires once per call that actually reaches the wire, so throttling
 * counts a digest challenge round-trip as the two requests it really is. A
 * batch pause exists to respect a remote rate limit; counting the pair as one
 * would send twice the traffic the user configured between pauses.
 */
async function fetchWithRuntimeAuth(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  auth: RuntimeCredentialAuth | undefined,
  onFetch: () => void,
): Promise<Response> {
  const send = (target: string, request: RequestInit) => {
    onFetch()
    return fetchImpl(target, request)
  }
  if (!auth) return send(url, init)
  const method = String(init.method ?? 'GET')
  if (auth.type === 'oauth1') {
    const headers = new Headers(init.headers)
    if (!headers.has('authorization')) headers.set('authorization', oauth1Authorization(url, method, auth, init))
    return send(url, { ...init, headers })
  }
  const first = await send(url, init)
  if (first.status !== 401) return first
  const challenge = digestChallenge(first.headers.get('www-authenticate') ?? '')
  if (!challenge) return first
  const headers = new Headers(init.headers)
  if (!headers.has('authorization')) headers.set('authorization', digestAuthorization(url, method, auth, challenge))
  return send(url, { ...init, headers })
}

/** Scheme + host + port. A port or scheme change IS a different origin. */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    // Unparseable: treat as foreign, i.e. strip. Failing closed is the only
    // safe default for a credential decision.
    return false
  }
}

/** Headers that are credentials regardless of who set them. */
const ALWAYS_CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie'])

/**
 * Drop every credential-bearing header for an off-origin hop.
 *
 * `injected` names the headers a vault credential contributed — a credential
 * may use ANY header name (`apiKeyHeader`, `custom`), so a hard-coded list
 * alone would still leak the most common case. Ordinary headers survive: they
 * are the caller's own metadata, not a secret.
 */
function withoutCredentials(headers: HeadersInit | undefined, injected?: readonly string[]): Record<string, string> {
  const drop = new Set([...ALWAYS_CREDENTIAL_HEADERS, ...(injected ?? []).map((name) => name.trim().toLowerCase())])
  const kept: Record<string, string> = {}
  new Headers(headers).forEach((value, key) => {
    if (!drop.has(key.toLowerCase())) kept[key] = value
  })
  return kept
}

/** 301/302/303 turn a non-GET into a GET and drop the body (RFC 9110 §15.4). */
function rewritesToGet(status: number, method: string): boolean {
  return (status === 301 || status === 302 || status === 303) && method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD'
}

const atPath = (value: unknown, path: unknown) =>
  String(path ?? '')
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((current, key) => (current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined), value)

/**
 * Execute one attempt of an http step: the redirect loop, optional pagination
 * (page / cursor / nextUrl with interval, stop-path, and batch throttling),
 * and response-envelope construction. Pure over its deps so the whole request
 * sequence is unit-testable; the executor supplies the real fetch, SSRF guard,
 * and abort signal, and wraps this in the retry/timeout machinery.
 */
export async function performHttpRequest(
  request: PreparedHttpRequest,
  policy: HttpRequestPolicy,
  deps: HttpRequestDeps = {},
): Promise<FlowHttpOutput | FlowHttpPaginatedOutput> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const sleep = deps.sleep ?? defaultSleep
  let requestCount = 0
  const batch = policy.batch && typeof policy.batch === 'object' ? (policy.batch as Record<string, unknown>) : null
  const batchSize = batch ? Math.max(1, Math.min(1000, Number(batch.size ?? 0) || 0)) : 0
  // Pause between requests: at batch boundaries (every `size` requests) and/or
  // every `intervalMs`. Applied before a request, never before the first —
  // so a sequence that ends exactly on a boundary doesn't pause pointlessly.
  const throttle = async (intervalMs: number) => {
    if (requestCount === 0) return
    if (batch && batchSize > 0 && requestCount % batchSize === 0) {
      const delayMs = Math.max(0, Math.min(60000, Number(batch.delayMs ?? 0) || 0))
      if (delayMs > 0) await sleep(delayMs)
    }
    if (intervalMs > 0) await sleep(intervalMs)
  }
  const fetchPage = async (initialUrl: string) => {
    let url = initialUrl
    let init: RequestInit = { ...request.init, ...(deps.signal ? { signal: deps.signal } : {}) }
    let auth = request.runtimeAuth
    for (let redirects = 0; ; redirects += 1) {
      await deps.assertUrlAllowed?.(url)
      const response = await fetchWithRuntimeAuth(fetchImpl, url, init, auth, () => { requestCount += 1 })
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        if (!request.followRedirects) throw new Error(`HTTP ${response.status}: redirect blocked (enable Follow redirects to allow it).`)
        if (redirects >= request.maxRedirects) throw new Error(`HTTP redirect limit (${request.maxRedirects}) exceeded.`)
        const nextUrl = new URL(response.headers.get('location')!, url).toString()
        // A redirect target is chosen by the REMOTE server, so it is
        // attacker-influenceable. Two rules, both matching what browsers and
        // curl do by default:
        //   - credentials never cross an origin boundary (curl requires an
        //     explicit --location-trusted for that), and
        //   - 301/302/303 rewrite to GET and drop the body, so a redirected
        //     write is never silently re-submitted to a new target.
        if (!sameOrigin(url, nextUrl)) {
          init = { ...init, headers: withoutCredentials(init.headers, request.credentialHeaders) }
          // Runtime auth SIGNS the request (OAuth1) or answers a challenge
          // (digest) — both are credentials by another name.
          auth = undefined
        }
        if (rewritesToGet(response.status, String(init.method ?? 'GET'))) {
          init = { ...init, method: 'GET', body: undefined }
        }
        url = nextUrl
        continue
      }
      const nextOutput = await responseOutput(response, request.responseType, deps.maxResponseChars ?? 50_000)
      const retryCodes = Array.isArray(policy.retryStatusCodes) ? policy.retryStatusCodes.map(Number) : []
      if (retryCodes.includes(nextOutput.status)) throw new Error(`HTTP ${nextOutput.status}: configured for retry.`)
      if (request.failOnHttpError && !nextOutput.ok) throw new Error(`HTTP ${nextOutput.status}: ${nextOutput.bodyText.slice(0, 200)}`)
      return nextOutput
    }
  }
  const pagination = policy.pagination && typeof policy.pagination === 'object' ? (policy.pagination as Record<string, unknown>) : null
  if (!pagination || pagination.mode === 'off' || !pagination.mode) return fetchPage(request.url)
  const pages: unknown[] = []
  const maxPages = Math.max(1, Math.min(1000, Number(pagination.maxPages ?? 100)))
  const intervalMs = Math.max(0, Math.min(60000, Number(pagination.intervalMs ?? 0) || 0))
  let pageUrl = request.url
  let cursor: unknown
  for (let page = Number(pagination.startPage ?? 1); pages.length < maxPages; page += 1) {
    await throttle(intervalMs)
    const url = new URL(pageUrl)
    if (pagination.mode === 'page') url.searchParams.set(String(pagination.pageParam ?? 'page'), String(page))
    if (pagination.mode === 'cursor' && cursor != null) url.searchParams.set(String(pagination.cursorParam ?? 'cursor'), String(cursor))
    const pageOutput = await fetchPage(url.toString())
    pages.push(pageOutput.body)
    // Explicit complete-condition: a truthy value at stopPath means this page
    // is the last one, regardless of mode-specific continuation state.
    if (typeof pagination.stopPath === 'string' && pagination.stopPath.trim() && Boolean(atPath(pageOutput.body, pagination.stopPath))) break
    if (pagination.mode === 'page') {
      if (pageOutput.body == null || (Array.isArray(pageOutput.body) && pageOutput.body.length === 0)) break
    } else if (pagination.mode === 'cursor') {
      const next = atPath(pageOutput.body, pagination.cursorPath ?? 'nextCursor')
      if (next == null || next === '' || next === cursor) break
      cursor = next
    } else {
      const next = atPath(pageOutput.body, pagination.nextUrlPath ?? 'next')
      if (typeof next !== 'string' || !next) break
      const resolved = new URL(next, pageUrl).toString()
      // The next-page URL comes from the RESPONSE BODY — remote-chosen, like a
      // redirect target. Unlike the redirect path above, pagination re-sends
      // the full credentialed init on every page, so an off-origin hop would
      // hand the Authorization header (or injected connection token) to
      // whatever host the body names. Real APIs paginate same-origin; refuse
      // anything else instead of quietly stripping auth mid-sequence.
      if (!sameOrigin(pageUrl, resolved)) {
        throw new Error(`Pagination stopped: the API returned a next-page URL on a different origin (${new URL(resolved).origin}), which is not allowed for credentialed requests.`)
      }
      pageUrl = resolved
    }
  }
  return { ok: true, pages, pageCount: pages.length }
}

// ── Connection auth: pure header helpers ────────────────────────────────────
// Injection happens server-side at fetch time only; the token never enters the
// graph JSON or persisted step rows. Redaction covers the user-supplied case.

const AUTH_HEADER_RE = /^(authorization|proxy-authorization)$/i

// Header keys are trimmed to match redactAuthHeaders; values that are empty or
// whitespace-only (e.g. a template that resolved to '') don't count as an
// explicit auth header — they must not block injection or be sent blank.
const hasAuthHeader = (headers: Record<string, string>) =>
  Object.entries(headers).some(([key, value]) => AUTH_HEADER_RE.test(key.trim()) && value.trim() !== '')

/**
 * Add `authorization: Bearer <token>` unless the request already carries a
 * non-empty Authorization header — an explicit user-supplied header always
 * wins. Empty/whitespace-only Authorization values are treated as absent and
 * dropped so the request never carries a blank credential next to the
 * injected one.
 */
export function withBearerAuthorization(headers: Record<string, string>, token: string): Record<string, string> {
  return withAuthorizationValue(headers, `Bearer ${token}`)
}

/** Same precedence as withBearerAuthorization for any Authorization scheme. */
function withAuthorizationValue(headers: Record<string, string>, value: string): Record<string, string> {
  if (hasAuthHeader(headers)) return headers
  const rest = Object.entries(headers).filter(([key]) => !AUTH_HEADER_RE.test(key.trim()))
  return { ...Object.fromEntries(rest), authorization: value }
}

/**
 * Replace the value of any Authorization-like header with 'redacted' so
 * persisted request details (FlowRunStep.input) never contain credentials.
 * Accepts the shapes an http step's `headers` config can hold: a parsed
 * object, a JSON string, or an arbitrary string.
 */
export function redactAuthHeaders(headers: unknown): unknown {
  if (isRecord(headers)) {
    return Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key, AUTH_HEADER_RE.test(key.trim()) ? 'redacted' : value]),
    )
  }
  if (typeof headers === 'string') {
    try {
      const parsed = JSON.parse(headers)
      if (isRecord(parsed)) return JSON.stringify(redactAuthHeaders(parsed))
    } catch {
      /* fall through */
    }
    // Not a JSON object — if it mentions an auth header at all, drop the whole
    // string rather than risk persisting a credential.
    return /authorization/i.test(headers) ? 'redacted' : headers
  }
  return headers
}

// The auth option's secret-bearing fields; username / header name stay visible.
const AUTH_SECRET_KEYS = new Set(['password', 'token', 'value'])

/**
 * Redact the secret-bearing fields of an http node's `auth` option, preserving
 * shape (type / username / header name stay visible so the step is still
 * recognisable and rebuildable).
 *
 * SINGLE SOURCE OF TRUTH: every sink that persists or emits an http node's
 * config must call this — persisted run rows (redactHttpStepInput) AND flow
 * export (lib/export/portable's sanitizeNode). Those two previously carried
 * independent field lists and drifted: `auth` was added to the run-row path and
 * missed on the export path, leaking bearer tokens into all five export
 * targets. Adding a new secret field here now covers both.
 */
export function redactHttpAuthOption(auth: unknown): unknown {
  if (!isRecord(auth)) return auth
  return Object.fromEntries(
    Object.entries(auth).map(([key, value]) => [key, AUTH_SECRET_KEYS.has(key) && value != null && value !== '' ? 'redacted' : value]),
  )
}

/**
 * An http step's config as safe to persist: auth header values and the auth
 * option's secrets (password/token/value) redacted, shape preserved.
 */
export function redactHttpStepInput(config: Record<string, unknown>): Record<string, unknown> {
  let next = config
  if (config.headers !== undefined && config.headers !== null) {
    next = { ...next, headers: redactAuthHeaders(config.headers) }
  }
  if (isRecord(config.auth)) {
    next = { ...next, auth: redactHttpAuthOption(config.auth) }
  }
  return next
}

function shouldParseJson(contentType: string, responseType: 'auto' | 'json' | 'text', text: string) {
  if (responseType === 'text') return false
  if (responseType === 'json') return true
  return contentType.toLowerCase().includes('json') || JSON_RE.test(text.trim())
}

export async function responseOutput(response: Response, responseType: 'auto' | 'json' | 'text' | 'binary', maxChars = 50_000): Promise<FlowHttpOutput> {
  if (responseType === 'binary') {
    const bytes = Buffer.from(await response.arrayBuffer())
    const bodyText = bytes.subarray(0, maxChars).toString('base64')
    return { ok: response.ok, status: response.status, statusText: response.statusText, url: response.url, headers: Object.fromEntries(response.headers.entries()), body: { encoding: 'base64', data: bodyText, size: bytes.length }, bodyText }
  }
  const bodyText = (await response.text()).slice(0, maxChars)
  const headers = Object.fromEntries(response.headers.entries())
  let body: unknown = bodyText
  if (bodyText && shouldParseJson(headers['content-type'] ?? '', responseType, bodyText)) {
    try {
      body = JSON.parse(bodyText)
    } catch {
      if (responseType === 'json') throw new Error('HTTP response was not valid JSON.')
    }
  }
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    headers,
    body,
    bodyText,
  }
}
import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { RuntimeCredentialAuth } from '@/lib/credentials/resolve'
