import http from 'node:http'

/**
 * Fake Anthropic-wire SSE endpoint for copilot-loop route tests. Each POST
 * serves the next scripted turn (the last turn repeats). Point QWEN_BASE_URL
 * at `url` — the Qwen provider speaks the same Messages API.
 */
export type FakeTurn = { text?: string; toolUse?: { id: string; name: string; input: Record<string, unknown> } }

function sseFor(turn: FakeTurn): string {
  const events: [string, unknown][] = [
    ['message_start', { type: 'message_start', message: { id: 'msg_f', type: 'message', role: 'assistant', model: 'qwen-fake', content: [], stop_reason: null, usage: { input_tokens: 50, output_tokens: 0 } } }],
  ]
  let index = 0
  if (turn.text) {
    events.push(
      ['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: turn.text } }],
      ['content_block_stop', { type: 'content_block_stop', index }],
    )
    index += 1
  }
  if (turn.toolUse) {
    events.push(
      ['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: turn.toolUse.id, name: turn.toolUse.name, input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(turn.toolUse.input) } }],
      ['content_block_stop', { type: 'content_block_stop', index }],
    )
  }
  events.push(
    ['message_delta', { type: 'message_delta', delta: { stop_reason: turn.toolUse ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } }],
    ['message_stop', { type: 'message_stop' }],
  )
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

export async function startFakeLlm(turns: FakeTurn[]) {
  let requests = 0
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      void raw
      const turn = turns[Math.min(requests, turns.length - 1)]
      requests += 1
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sseFor(turn))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}`,
    get requests() {
      return requests
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
