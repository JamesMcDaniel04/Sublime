/**
 * Client half of the copilot SSE protocol: POST, then dispatch parsed events
 * to callbacks until the terminal result/error event. A JSON response (4xx
 * before the stream opened, or the legacy non-streaming path) is handled
 * transparently so callers have exactly one code path.
 */
export type CopilotStreamCallbacks = {
  onText?: (delta: string) => void
  onTool?: (activity: { name: string; label: string }) => void
}

export type CopilotStreamOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string; code?: string; status?: number }

export async function streamCopilot(
  url: string,
  body: unknown,
  callbacks: CopilotStreamCallbacks,
): Promise<CopilotStreamOutcome> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
    })
  } catch {
    return { ok: false, error: 'Connection lost — check your network and resend.' }
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) {
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (response.ok && data.success) return { ok: true, result: data }
    return {
      ok: false,
      error: typeof data.error === 'string' ? data.error : 'The assistant is unavailable right now.',
      ...(typeof data.code === 'string' ? { code: data.code } : {}),
      status: response.status,
    }
  }

  const reader = response.body?.getReader()
  if (!reader) return { ok: false, error: 'Connection lost — resend to try again.' }
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      boundary = buffer.indexOf('\n\n')
      if (!frame.startsWith('data: ')) continue
      let event: Record<string, unknown>
      try {
        event = JSON.parse(frame.slice(6)) as Record<string, unknown>
      } catch {
        continue
      }
      if (event.type === 'text' && typeof event.delta === 'string') callbacks.onText?.(event.delta)
      else if (event.type === 'tool' && typeof event.label === 'string') {
        callbacks.onTool?.({ name: String(event.name ?? ''), label: event.label })
      } else if (event.type === 'result') return { ok: true, result: event }
      else if (event.type === 'error') {
        return {
          ok: false,
          error: typeof event.message === 'string' ? event.message : 'The assistant could not respond.',
          ...(typeof event.code === 'string' ? { code: event.code } : {}),
        }
      }
    }
  }
  return { ok: false, error: 'Connection lost — resend to try again.' }
}
