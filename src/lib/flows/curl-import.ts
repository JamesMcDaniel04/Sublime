/**
 * Parse a pasted cURL command into http-node data fields (the n8n "Import
 * cURL" convenience). Pure string → config mapping; no network access. Throws
 * with a plain-english message when the text isn't a usable curl command.
 */

export type CurlImportResult = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'
  url: string
  headers?: string
  body?: string
  bodyMode?: 'json' | 'text' | 'multipart'
  cookie?: string
  auth?: { type: 'basic'; username: string; password: string }
  followRedirects?: boolean
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

// Value-taking flags we deliberately ignore (output files, timeouts, etc.) —
// they must still consume their argument so it isn't mistaken for the URL.
const IGNORED_WITH_VALUE = new Set([
  '-o', '--output', '--connect-timeout', '--max-time', '-m', '--retry', '--cacert', '--capath',
  '-A', '--user-agent', '-e', '--referer', '--proxy', '-x', '-c', '--cookie-jar', '--ciphers',
])

/** Shell-ish tokenizer: single/double quotes, backslash escapes, `\` line continuations. */
function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: "'" | '"' | null = null
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      else current += ch
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      else if (ch === '\\' && i + 1 < input.length && '"\\$`'.includes(input[i + 1])) {
        current += input[i + 1]
        i += 1
      } else current += ch
      continue
    }
    if (ch === '\\') {
      // Line continuation or escaped char outside quotes
      if (i + 1 < input.length && input[i + 1] === '\n') {
        i += 1
        continue
      }
      current += input[i + 1] ?? ''
      i += 1
      started = true
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started) tokens.push(current)
      current = ''
      started = false
      continue
    }
    current += ch
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

const looksLikeJson = (text: string) => /^(?:\{|\[)/.test(text.trim())

export function parseCurlCommand(input: string): CurlImportResult {
  const tokens = tokenize(input.trim())
  if (tokens[0] !== 'curl') throw new Error('Paste a command that starts with `curl`.')

  let method: string | undefined
  let url: string | undefined
  const headers: Record<string, string> = {}
  const dataParts: string[] = []
  const formParts: Record<string, string> = {}
  let cookie: string | undefined
  let auth: CurlImportResult['auth']
  let followRedirects: boolean | undefined

  const next = (index: number, flag: string): string => {
    const value = tokens[index + 1]
    if (value === undefined) throw new Error(`The ${flag} flag is missing its value.`)
    return value
  }

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === '-X' || token === '--request') {
      method = next(i, token).toUpperCase()
      i += 1
    } else if (token === '-H' || token === '--header') {
      const raw = next(i, token)
      i += 1
      const colon = raw.indexOf(':')
      if (colon > 0) {
        const name = raw.slice(0, colon).trim()
        const value = raw.slice(colon + 1).trim()
        if (name.toLowerCase() === 'cookie') cookie = value
        else headers[name] = value
      }
    } else if (token === '-d' || token === '--data' || token === '--data-raw' || token === '--data-binary' || token === '--data-urlencode' || token === '--data-ascii') {
      dataParts.push(next(i, token).replace(/^\$/, ''))
      i += 1
    } else if (token === '-F' || token === '--form') {
      const raw = next(i, token)
      i += 1
      const eq = raw.indexOf('=')
      if (eq > 0) formParts[raw.slice(0, eq)] = raw.slice(eq + 1)
    } else if (token === '-u' || token === '--user') {
      const raw = next(i, token)
      i += 1
      const colon = raw.indexOf(':')
      auth = { type: 'basic', username: colon >= 0 ? raw.slice(0, colon) : raw, password: colon >= 0 ? raw.slice(colon + 1) : '' }
    } else if (token === '-b' || token === '--cookie') {
      cookie = next(i, token)
      i += 1
    } else if (token === '--url') {
      url = next(i, token)
      i += 1
    } else if (token === '-L' || token === '--location') {
      followRedirects = true
    } else if (IGNORED_WITH_VALUE.has(token)) {
      i += 1
    } else if (token.startsWith('-')) {
      // Ignored boolean flags: --compressed, -s, -S, -k, -i, -v, …
    } else if (!url) {
      url = token
    }
  }

  if (!url) throw new Error('No URL found in the curl command.')
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`

  const result: CurlImportResult = {
    method: (METHODS.has(method ?? '') ? method : dataParts.length || Object.keys(formParts).length ? 'POST' : 'GET') as CurlImportResult['method'],
    url,
  }

  if (Object.keys(formParts).length) {
    result.bodyMode = 'multipart'
    result.body = JSON.stringify(formParts)
  } else if (dataParts.length) {
    const body = dataParts.join('&')
    result.body = body
    if (looksLikeJson(body)) result.bodyMode = 'json'
    else {
      result.bodyMode = 'text'
      // curl -d defaults to form encoding; preserve that unless a Content-Type
      // header was pasted explicitly.
      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
      }
    }
  }

  if (Object.keys(headers).length) result.headers = JSON.stringify(headers)
  if (cookie) result.cookie = cookie
  if (auth) result.auth = auth
  if (followRedirects) result.followRedirects = true
  return result
}
