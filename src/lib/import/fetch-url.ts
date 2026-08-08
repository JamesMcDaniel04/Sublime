/**
 * Import-from-URL fetcher. The URL is user-supplied and this fetch runs
 * server-side, so SSRF is the threat model (same stance as
 * src/lib/metrics/sources/url.ts): egress allowlist + public-URL assertion
 * re-run on EVERY redirect hop, https only, bounded time and bytes.
 */
import { assertEgressAllowed } from '@/lib/integrations/http'
import { fetchPublicUrl } from '@/lib/net/ssrf'

const TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 3
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024

async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_IMPORT_BYTES) {
    throw new Error('That file is too large to import (2 MB max).')
  }
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_IMPORT_BYTES) {
      await reader.cancel()
      throw new Error('That file is too large to import (2 MB max).')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function fetchImportDocument(rawUrl: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let url = rawUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    assertEgressAllowed(url)
    const response = await fetchPublicUrl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json, text/plain, */*' },
    }, fetchImpl)
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error('The URL redirected without a destination.')
      url = new URL(location, url).toString()
      continue
    }
    if (!response.ok) throw new Error(`The URL responded with ${response.status}.`)
    return await readCapped(response)
  }
  throw new Error('The URL redirected too many times.')
}
