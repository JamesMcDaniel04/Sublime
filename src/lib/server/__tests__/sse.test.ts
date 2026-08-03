import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sseResponse } from '../sse'

async function readAll(response: Response): Promise<string> {
  return await new Response(response.body).text()
}

test('encodes each emitted event as a data: line', async () => {
  const response = sseResponse(async (emit) => {
    emit({ type: 'text', delta: 'hi' })
    emit({ type: 'result', ok: true })
  })
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream')
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  const bodyText = await readAll(response)
  assert.equal(bodyText, 'data: {"type":"text","delta":"hi"}\n\ndata: {"type":"result","ok":true}\n\n')
})

test('a thrown handler becomes a terminal error event, not a broken stream', async () => {
  const response = sseResponse(async (emit) => {
    emit({ type: 'text', delta: 'partial' })
    throw new Error('model exploded')
  })
  const bodyText = await readAll(response)
  assert.match(bodyText, /"type":"error"/)
  assert.match(bodyText, /model exploded/)
})
