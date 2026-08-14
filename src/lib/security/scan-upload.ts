/**
 * Malware scanning for uploaded files.
 *
 * The audit found no scanning of any kind on a path that hands attacker-chosen
 * bytes to `pdf-parse` and `mammoth` in-process. Signature checks
 * (src/lib/security/file-signature.ts) prove a file is the TYPE it claims;
 * they say nothing about whether its contents are hostile.
 *
 * Deliberately transport-agnostic: POST the bytes, read a verdict. That works
 * against a ClamAV REST sidecar, a cloud scanning API behind a small shim, or
 * anything else that speaks the same two-field JSON. The alternative — binding
 * to a specific vendor SDK — would have made this a dependency decision instead
 * of a deployment one.
 *
 * Gated like every other optional integration here: with UPLOAD_SCANNER_URL
 * unset this is a clean no-op, so nothing changes for a developer machine or
 * for a deployment that has not stood a scanner up yet.
 *
 * Expected response: `{ "infected": boolean, "viruses"?: string[] }`.
 */

const TIMEOUT_MS = 10_000

export class MalwareDetectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MalwareDetectedError'
  }
}

/** True when a scanner endpoint is configured and uploads are therefore scanned. */
export function uploadScanningConfigured(): boolean {
  return Boolean(process.env.UPLOAD_SCANNER_URL)
}

/**
 * Throws `MalwareDetectedError` unless the scanner returns a clean verdict.
 * Resolves immediately when no scanner is configured.
 *
 * Fails CLOSED. An upload path that accepts files while the scanner is
 * unreachable is an upload path with no scanner, and the failure would be
 * invisible — which is precisely how scanning silently stops happening. The
 * blast radius is bounded: only the two document-upload routes call this, so a
 * scanner outage costs knowledge ingestion, never sign-in or flow execution.
 *
 * `fetchImpl` is the same testing seam used by src/lib/import/fetch-url.ts.
 */
export async function scanUpload(
  buffer: Buffer,
  filename: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const endpoint = process.env.UPLOAD_SCANNER_URL
  if (!endpoint) return

  let verdict: { infected?: boolean; viruses?: string[] }
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        // Advisory only — the scanner classifies by content. Sent so its logs
        // name the same file ours do when something is caught.
        'x-filename': encodeURIComponent(filename),
      },
      body: new Uint8Array(buffer),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new MalwareDetectedError('Could not scan this file for malware — please try again shortly.')
    }
    verdict = (await response.json()) as { infected?: boolean; viruses?: string[] }
  } catch (error) {
    if (error instanceof MalwareDetectedError) throw error
    throw new MalwareDetectedError('Could not scan this file for malware — please try again shortly.')
  }

  // Only an explicit `infected: false` is a pass. A response that omits the
  // field has not said "clean", and treating it as clean is how a
  // misconfigured endpoint disables scanning without anyone noticing.
  if (verdict?.infected === false) return

  const signatures = verdict?.viruses?.length ? ` (${verdict.viruses.join(', ')})` : ''
  throw new MalwareDetectedError(`This file was rejected by malware scanning${signatures}.`)
}
