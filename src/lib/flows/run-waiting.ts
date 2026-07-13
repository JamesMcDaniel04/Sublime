// Derives the run-level `waiting` object exposed by the runs API from a run's
// status + steps. A waiting agent step persists its pause reason in
// output.waiting ({ kind, question?, approvalId? }); this surfaces what the
// run is blocked on so reply/approval UIs know what to render.

export type RunWaiting = { nodeId: string; kind: 'input' | 'approval' | 'time'; question?: string; wakeAt?: string }

export function deriveRunWaiting(
  status: string,
  steps: { nodeId: string; status: string; output?: unknown }[],
): RunWaiting | null {
  if (status !== 'waiting') return null
  // Steps arrive ordered by `order` asc; the LAST waiting step is the live
  // pause. A resume resolves old waiting rows, but if a stale one survives
  // (legacy runs) the latest pause must still win so reply UIs target it.
  let step: (typeof steps)[number] | undefined
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].status === 'waiting') {
      step = steps[i]
      break
    }
  }
  if (!step) return null
  const info = (step.output as { waiting?: { kind?: string; question?: string; wakeAt?: string } } | null | undefined)?.waiting
  return {
    nodeId: step.nodeId,
    kind: info?.kind === 'approval' ? ('approval' as const) : info?.kind === 'time' ? ('time' as const) : ('input' as const),
    question: info?.question,
    ...(info?.wakeAt ? { wakeAt: info.wakeAt } : {}),
  }
}
