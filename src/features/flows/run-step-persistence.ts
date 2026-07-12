const ADAPTER_PERSISTED_TYPES = new Set(['agent', 'tool', 'http', 'subflow'])

export function shouldPersistInterpreterStep(nodeType: string | undefined): boolean {
  return !nodeType || !ADAPTER_PERSISTED_TYPES.has(nodeType)
}
