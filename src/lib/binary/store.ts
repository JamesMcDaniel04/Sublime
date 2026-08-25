import { storageKeyFor } from './handle'

/**
 * The blob store behind binary handles.
 *
 * **Driver scope is deliberate.** Supabase Storage is an HTTP API with a
 * bearer token and we already hold the credentials, so it needs no new
 * dependency and no request signing. A native S3 driver needs SigV4 — the same
 * reasoning that kept AWS out of the external-secrets work applies here, and a
 * store that works sometimes is worse than one that is clearly absent. The
 * interface below is what makes adding it additive rather than a rewrite.
 */

/**
 * The largest single blob.
 *
 * Without a ceiling, one flow downloading a large file exhausts the worker's
 * memory and takes every concurrent run down with it. 25 MB comfortably covers
 * the reports, exports and attachments flows actually move, and anything
 * larger belongs in a purpose-built pipeline rather than passing through a
 * step's output.
 */
export const MAX_BINARY_BYTES = 25 * 1024 * 1024

export interface BinaryStore {
  put(organizationId: string, id: string, bytes: Buffer, mimeType: string): Promise<void>
  get(organizationId: string, id: string): Promise<Buffer | null>
  delete(organizationId: string, id: string): Promise<void>
}

function assertSize(bytes: Buffer): void {
  if (bytes.length > MAX_BINARY_BYTES) {
    throw new Error(`That file is too large (${bytes.length} bytes, limit ${MAX_BINARY_BYTES}).`)
  }
}

/**
 * In-process storage, for development and tests.
 *
 * Never used in production: it is per-process, so the web request that serves
 * a download would not see what the worker wrote.
 */
export class MemoryBinaryStore implements BinaryStore {
  private readonly blobs = new Map<string, Buffer>()

  async put(organizationId: string, id: string, bytes: Buffer, _mimeType: string): Promise<void> {
    assertSize(bytes)
    // Through the key helper on every path: the store is the last thing
    // between a crafted value and real storage, so it validates rather than
    // trusting a caller to have done it.
    this.blobs.set(storageKeyFor(organizationId, id), bytes)
  }

  async get(organizationId: string, id: string): Promise<Buffer | null> {
    return this.blobs.get(storageKeyFor(organizationId, id)) ?? null
  }

  async delete(organizationId: string, id: string): Promise<void> {
    this.blobs.delete(storageKeyFor(organizationId, id))
  }
}

const BUCKET = 'flow-binary'

/**
 * Supabase Storage, over its REST API.
 *
 * The service-role key is required: this is server-side only, and the bucket
 * is private — a public bucket would make every blob readable by URL to anyone
 * who guessed an id, which is precisely what the workspace-scoped key exists
 * to prevent.
 */
export class SupabaseBinaryStore implements BinaryStore {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(organizationId: string, id: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}/storage/v1/object/${BUCKET}/${storageKeyFor(organizationId, id)}`
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.serviceKey}`, apikey: this.serviceKey }
  }

  async put(organizationId: string, id: string, bytes: Buffer, mimeType: string): Promise<void> {
    assertSize(bytes)
    const response = await this.fetchImpl(this.url(organizationId, id), {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': mimeType || 'application/octet-stream' },
      body: new Uint8Array(bytes),
    })
    if (!response.ok) {
      // The status only: a storage error body can echo the path and the token.
      throw new Error(`The file could not be stored (HTTP ${response.status}).`)
    }
  }

  async get(organizationId: string, id: string): Promise<Buffer | null> {
    const response = await this.fetchImpl(this.url(organizationId, id), { headers: this.headers() })
    // A miss and a cross-workspace guess are indistinguishable by design: the
    // key already scoped the lookup, so 404 is the honest answer to both.
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`The file could not be read (HTTP ${response.status}).`)
    return Buffer.from(await response.arrayBuffer())
  }

  async delete(organizationId: string, id: string): Promise<void> {
    const response = await this.fetchImpl(this.url(organizationId, id), { method: 'DELETE', headers: this.headers() })
    // Already gone is success — retention must be safe to run twice.
    if (!response.ok && response.status !== 404) {
      throw new Error(`The file could not be deleted (HTTP ${response.status}).`)
    }
  }
}

let cached: BinaryStore | null = null

/**
 * The store this deployment uses.
 *
 * Falls back to memory when Supabase is not configured, which is correct for
 * tests and local development and visibly wrong in production — a download
 * served by a different process than the one that wrote it returns nothing,
 * which surfaces immediately rather than corrupting data quietly.
 */
export function binaryStore(env: Record<string, string | undefined> = process.env): BinaryStore {
  if (cached) return cached
  const url = env.NEXT_PUBLIC_SUPABASE_URL
  const key = env.SUPABASE_SERVICE_ROLE_KEY
  cached = url && key ? new SupabaseBinaryStore(url, key) : new MemoryBinaryStore()
  return cached
}

/** Tests only: drop the memoized driver. */
export function resetBinaryStore(): void {
  cached = null
}
