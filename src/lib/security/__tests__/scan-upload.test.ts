import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MalwareDetectedError, scanUpload, uploadScanningConfigured } from '../scan-upload'

const clean = async () => new Response(JSON.stringify({ infected: false }), { status: 200 })
const infected = async () =>
  new Response(JSON.stringify({ infected: true, viruses: ['Eicar-Test-Signature'] }), { status: 200 })

beforeEach(() => {
  delete process.env.UPLOAD_SCANNER_URL
})

test('no-ops when no scanner is configured', async () => {
  assert.equal(uploadScanningConfigured(), false)
  await assert.doesNotReject(() => scanUpload(Buffer.from('anything'), 'a.txt'))
})

test('accepts a file the scanner reports clean', async () => {
  process.env.UPLOAD_SCANNER_URL = 'https://scanner.internal/scan'
  assert.equal(uploadScanningConfigured(), true)
  await assert.doesNotReject(() => scanUpload(Buffer.from('hello'), 'a.txt', clean))
})

test('rejects a file the scanner reports infected, naming the signature', async () => {
  process.env.UPLOAD_SCANNER_URL = 'https://scanner.internal/scan'
  await assert.rejects(() => scanUpload(Buffer.from('x'), 'a.txt', infected), (error: unknown) => {
    assert.ok(error instanceof MalwareDetectedError)
    assert.match(error.message, /Eicar-Test-Signature/)
    return true
  })
})

test('forwards the bytes unmodified so the scanner sees what we would store', async () => {
  process.env.UPLOAD_SCANNER_URL = 'https://scanner.internal/scan'
  // The EICAR test string — the standard way to prove a scanner path is live
  // without shipping real malware.
  const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')
  const bodies: Buffer[] = []
  const spy = async (_url: any, init: any) => {
    bodies.push(Buffer.from(init.body))
    return new Response(JSON.stringify({ infected: false }), { status: 200 })
  }
  await scanUpload(eicar, 'eicar.com', spy as any)
  assert.equal(bodies.length, 1)
  assert.ok(bodies[0].equals(eicar), 'scanner received different bytes than were uploaded')
})

test('fails CLOSED when the scanner is unreachable', async () => {
  // An upload path that accepts files when the scanner is down is an upload
  // path with no scanner. Same stance as src/lib/security/turnstile.ts and the
  // deliberate opposite of the rate limiter, which trades enforcement for
  // availability and says so.
  process.env.UPLOAD_SCANNER_URL = 'https://scanner.internal/scan'
  const boom = async () => {
    throw new Error('ECONNREFUSED')
  }
  await assert.rejects(() => scanUpload(Buffer.from('x'), 'a.txt', boom), MalwareDetectedError)
})

test('fails closed on a non-OK scanner response', async () => {
  process.env.UPLOAD_SCANNER_URL = 'https://scanner.internal/scan'
  const down = async () => new Response('scanner busy', { status: 503 })
  await assert.rejects(() => scanUpload(Buffer.from('x'), 'a.txt', down), MalwareDetectedError)
})

test('fails closed on a response it cannot interpret', async () => {
  // A scanner that answers 200 with something other than a verdict has not
  // said "clean" — treating an unparseable answer as clean is how a
  // misconfigured endpoint silently disables scanning.
  process.env.UPLOAD_SCANNER_URL = 'https://scanner.internal/scan'
  const garbage = async () => new Response('<html>proxy error</html>', { status: 200 })
  await assert.rejects(() => scanUpload(Buffer.from('x'), 'a.txt', garbage), MalwareDetectedError)
})
