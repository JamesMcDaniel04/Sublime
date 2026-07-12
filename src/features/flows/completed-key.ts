// Composite `completed`-map key for a step that ran inside a loop body: its
// iteration path (outermost -> innermost 0-based indices) disambiguates the
// SAME node id executing once per iteration. A step with no iteration path
// (never ran inside a loop) keeps today's plain-nodeId key — so a flow with
// no loops resumes byte-identically to before this change.
const ITER_SEP = '#i:'

export function completedKey(nodeId: string, iterationPath?: number[]): string {
  return iterationPath && iterationPath.length ? `${nodeId}${ITER_SEP}${iterationPath.join('.')}` : nodeId
}

export function nodeIdOfCompletedKey(key: string): string {
  const at = key.indexOf(ITER_SEP)
  return at === -1 ? key : key.slice(0, at)
}
