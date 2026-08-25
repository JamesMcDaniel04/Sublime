import { NextResponse } from 'next/server'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { binaryStore } from '@/lib/binary/store'

export const runtime = 'nodejs'

/**
 * GET /api/binary/{id} — download a file a flow produced.
 *
 * **The workspace comes from the session, never from the URL.** A binary id
 * travels through a graph and can be hand-written into a step's config, so by
 * the time it arrives here it is untrusted input. Scoping the lookup by the
 * caller's own workspace means a guessed or forged id can only ever address
 * that workspace's own files — see lib/binary/handle.ts.
 *
 * A miss and a cross-workspace guess both return 404, which is the honest
 * answer to both and tells a prober nothing about what exists elsewhere.
 */
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-1)
  if (!id) throw new ApiError('A file id is required.', 400, 'BAD_REQUEST')

  let bytes: Buffer | null
  try {
    bytes = await binaryStore().get(auth.organizationId, id)
  } catch {
    // A malformed id throws from the key helper. That is a bad request, not a
    // server error, and it must not be distinguishable from a miss.
    throw new ApiError('File not found.', 404, 'NOT_FOUND')
  }
  if (!bytes) throw new ApiError('File not found.', 404, 'NOT_FOUND')

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      // Deliberately generic, and always an attachment. The stored mime type
      // is derived from a response WE fetched from a third party, so serving
      // it inline would let a flow that downloaded an HTML or SVG file get it
      // rendered on our origin — stored XSS by way of an automation step.
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${id}"`,
      'content-length': String(bytes.length),
      // Per-workspace private data: no shared cache may hold it.
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}, { requires: 'member' })
