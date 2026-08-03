/**
 * Server-sent-events response for the copilot chat routes. `data:`-only wire
 * format (no event: names) — the client switches on the JSON `type` field.
 * The handler's own throw becomes a terminal {type:'error'} event: once the
 * stream has started we can no longer change the HTTP status, so the error
 * must travel in-band.
 */
export function sseResponse(run: (emit: (event: object) => void) => Promise<void>): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      try {
        await run(emit)
      } catch (error) {
        emit({ type: 'error', message: error instanceof Error ? error.message : 'The assistant could not respond.' })
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // Disable proxy buffering so tokens reach the browser as they are written.
      'X-Accel-Buffering': 'no',
    },
  })
}
