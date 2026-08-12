const ADAPTER_PERSISTED_TYPES = new Set(['agent', 'tool', 'http', 'subflow'])

/**
 * Adapter-persisted types create their own running→terminal rows, so the
 * interpreter's outcome for them is normally dropped here — EXCEPT a
 * `skipped` outcome (deactivated node, or a resume replay): no adapter ever
 * runs for those, so the interpreter's row is the only record and dropping it
 * makes the step vanish from run history.
 */
export function shouldPersistInterpreterStep(nodeType: string | undefined, status?: string): boolean {
  if (status === 'skipped') return true
  return !nodeType || !ADAPTER_PERSISTED_TYPES.has(nodeType)
}
