import { randomBytes } from 'node:crypto'

/**
 * Binary data in a flow, as a reference rather than bytes.
 *
 * **What this replaces.** A binary HTTP response was base64'd and TRUNCATED
 * into the run row. Both halves are wrong: base64 in a Postgres JSON column
 * bloats every run record, and truncation means a downloaded PDF is stored
 * corrupt — the flow appears to succeed and produces a broken file.
 *
 * So the bytes go to a blob store and the graph carries this handle. It is
 * what a step passes downstream, what a run row records, and what a person
 * eventually downloads.
 */

/** Marks an object as a handle, so a step's output can be told apart. */
export const BINARY_MARKER = '__binary' as const

export interface BinaryHandle {
  readonly [BINARY_MARKER]: true
  id: string
  fileName: string
  mimeType: string
  size: number
  /** Which run produced it, for retention. */
  flowRunId: string
}

/** An id is opaque and flat — see storageKeyFor for why that is enforced. */
const ID_RE = /^[a-f0-9]{32}$/

export function createBinaryHandle(input: {
  organizationId: string
  flowRunId: string
  fileName: string
  mimeType: string
  size: number
}): BinaryHandle {
  return {
    [BINARY_MARKER]: true,
    id: randomBytes(16).toString('hex'),
    fileName: input.fileName,
    mimeType: input.mimeType,
    size: input.size,
    flowRunId: input.flowRunId,
  }
}

export function isBinaryHandle(value: unknown): value is BinaryHandle {
  return Boolean(
    value && typeof value === 'object' && !Array.isArray(value) &&
    (value as Record<string, unknown>)[BINARY_MARKER] === true &&
    typeof (value as BinaryHandle).id === 'string',
  )
}

/**
 * Where the bytes live.
 *
 * **The organization comes from the CALLER, never from the handle.** A handle
 * travels through a graph and can be hand-written into a step's config, so by
 * the time it reaches a download it is untrusted input. Deriving the key from
 * the caller's own workspace means a forged handle can only ever address that
 * workspace's prefix — the id becomes a guess at one of their own files rather
 * than a way to reach someone else's.
 *
 * Both components are validated rather than escaped: an id is a fixed-shape
 * hex string and a workspace id has no slashes, so anything else is a
 * traversal attempt and is refused outright.
 */
export function storageKeyFor(organizationId: string, id: string): string {
  if (!ID_RE.test(id)) throw new Error('That is not a valid binary id.')
  if (!organizationId || organizationId.includes('/') || organizationId.includes('..')) {
    throw new Error('That is not a valid workspace for binary storage.')
  }
  return `${organizationId}/${id}`
}

/**
 * Every handle inside a value.
 *
 * Retention needs this: when a run is deleted its blobs must go too, and the
 * only record of which blobs a run produced is the handles in its output.
 */
export function binaryHandlesIn(value: unknown): BinaryHandle[] {
  const found: BinaryHandle[] = []
  const walk = (input: unknown) => {
    if (isBinaryHandle(input)) { found.push(input); return }
    if (Array.isArray(input)) { input.forEach(walk); return }
    if (input && typeof input === 'object') Object.values(input as Record<string, unknown>).forEach(walk)
  }
  walk(value)
  return found
}
