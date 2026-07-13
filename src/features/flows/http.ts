export type FlowHttpConfig = {
  connectionId?: unknown
  method?: unknown
  url?: unknown
  query?: unknown
  headers?: unknown
  body?: unknown
  bodyMode?: unknown
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

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const JSON_RE = /^(?:\{|\[|true|false|null|-?\d|")/

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

function queryUrl(url: string, query: unknown): string {
  const params = parseObjectInput(query, 'Query params')
  if (!Object.keys(params).length) return url
  const next = new URL(url)
  for (const [key, value] of Object.entries(params)) {
    if (!key.trim() || value == null || value === '') continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item != null && item !== '') next.searchParams.append(key, String(item))
      }
      continue
    }
    next.searchParams.set(key, String(value))
  }
  return next.toString()
}

function explicitBodyMode(value: unknown): 'json' | 'text' | 'raw' | 'formUrlencoded' | 'multipart' | 'binary' | 'none' | undefined {
  return ['json', 'text', 'raw', 'formUrlencoded', 'multipart', 'binary', 'none'].includes(String(value)) ? value as 'json' | 'text' | 'raw' | 'formUrlencoded' | 'multipart' | 'binary' | 'none' : undefined
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

export function prepareHttpRequest(config: FlowHttpConfig): { url: string; init: RequestInit; timeoutMs: number; failOnHttpError: boolean; responseType: 'auto' | 'json' | 'text' | 'binary'; followRedirects: boolean; maxRedirects: number } {
  const method = String(config.method || 'POST').toUpperCase()
  const url = queryUrl(String(config.url || ''), config.query)
  const headers = headersFrom(config.headers)
  // The Cookie field is a convenience for the common single-header case; an
  // explicit Cookie among `headers` always wins.
  if (typeof config.cookie === 'string' && config.cookie.trim() !== '' && !Object.keys(headers).some((key) => key.toLowerCase() === 'cookie')) {
    headers.cookie = config.cookie
  }
  const mode = explicitBodyMode(config.bodyMode) ?? inferBodyMode(config.body)
  const bodyAllowed = BODY_METHODS.has(method)
  let body: BodyInit | undefined
  if (bodyAllowed && mode !== 'none') {
    if (mode === 'json') body = jsonBody(config.body)
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
    if (mode === 'json' && body && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json'
    }
    if (mode === 'formUrlencoded' && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) headers['content-type'] = 'application/x-www-form-urlencoded'
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
  if (hasAuthHeader(headers)) return headers
  const rest = Object.entries(headers).filter(([key]) => !AUTH_HEADER_RE.test(key.trim()))
  return { ...Object.fromEntries(rest), authorization: `Bearer ${token}` }
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

/** An http step's config as safe to persist: auth header values redacted. */
export function redactHttpStepInput(config: Record<string, unknown>): Record<string, unknown> {
  if (config.headers === undefined || config.headers === null) return config
  return { ...config, headers: redactAuthHeaders(config.headers) }
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
