import type { FlowNode } from './graph'

/**
 * Container membership, shared by the canvas widgets and the NDV's child list.
 * Lived inside dag-canvas until the NDV needed the same answers.
 */

/** The child ids a container owns — mirrors auto-layout/interpreter `contained`. */
export function containerChildIds(node: FlowNode): string[] {
  return node.type === 'loop' || node.type === 'repeatUntil' ? node.data.body
    : node.type === 'parallel' ? node.data.branches.flat()
    : node.type === 'errorShield' ? [...node.data.body, ...node.data.fallback]
    : []
}

export const isContainerNode = (node: FlowNode) =>
  node.type === 'loop' || node.type === 'repeatUntil' || node.type === 'parallel' || node.type === 'errorShield'

/**
 * The sibling list a contained id can be reordered WITHIN, and the branch marker
 * `onReorderContainer` expects. Mirrors the stack canvas exactly: a parallel
 * branch reorders only within its own branch array, and an errorShield's
 * fallback list is marked with branchIndex -1 (insertIntoContainer's convention).
 */
export function siblingsOf(container: FlowNode, childId: string): { list: string[]; branchIndex?: number } {
  if (container.type === 'loop' || container.type === 'repeatUntil') return { list: container.data.body }
  if (container.type === 'parallel') {
    const branchIndex = container.data.branches.findIndex((branch) => branch.includes(childId))
    return { list: branchIndex >= 0 ? container.data.branches[branchIndex] : [], branchIndex: branchIndex >= 0 ? branchIndex : undefined }
  }
  if (container.type === 'errorShield') {
    return container.data.body.includes(childId) ? { list: container.data.body } : { list: container.data.fallback, branchIndex: -1 }
  }
  return { list: [] }
}
