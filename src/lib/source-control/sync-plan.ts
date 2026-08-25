import { flowFileContent, flowFilePath, flowIdFromFile } from './flow-file'

/**
 * What a push or pull would change, computed before anything is written.
 *
 * Both directions produce a plan first so both can be previewed. Source
 * control that applies changes nobody saw is worse than none at all — the
 * reason to put flows in a repository is that a person reviews the change.
 *
 * **Neither direction deletes.** A flow missing from one side is left alone
 * rather than removed from the other. A sync that destroys work because
 * something was absent is the failure mode that makes people stop trusting the
 * feature, and the recovery ("restore it from the history you just erased") is
 * not available in the push direction. Deleting stays an explicit act.
 */

export interface RemoteFile {
  path: string
  content: string
  sha: string
}

export interface LocalFlow {
  id: string
  name: string
  description?: string | null
  trigger?: unknown
  graph: unknown
}

export interface PushChange {
  action: 'create' | 'update' | 'delete'
  path: string
  content?: string
  /** The blob being replaced or removed — omitted for a create. */
  sha?: string
  flowId: string
}

/**
 * What pushing local flows to the repository would change.
 *
 * A rename changes the file's path, so it plans as a create at the new path
 * plus a delete of the old one. That reads correctly in review, and git
 * records it as a rename by content similarity.
 */
export function pushPlan(flows: LocalFlow[], remote: RemoteFile[]): PushChange[] {
  const byPath = new Map(remote.map((file) => [file.path, file]))
  // Which remote file currently holds each flow, whatever it is called.
  const byFlowId = new Map<string, RemoteFile>()
  for (const file of remote) {
    const id = flowIdFromFile(file.content)
    if (id) byFlowId.set(id, file)
  }

  const changes: PushChange[] = []
  for (const flow of flows) {
    const path = flowFilePath(flow)
    const content = flowFileContent(flow)
    const atPath = byPath.get(path)

    if (atPath) {
      // Byte comparison, which the canonical serializer makes meaningful: an
      // unchanged flow is genuinely identical, so a routine push is a no-op.
      if (atPath.content !== content) {
        changes.push({ action: 'update', path, content, sha: atPath.sha, flowId: flow.id })
      }
      continue
    }

    changes.push({ action: 'create', path, content, flowId: flow.id })

    // The same flow living at a different path means it was renamed.
    const existing = byFlowId.get(flow.id)
    if (existing && existing.path !== path) {
      changes.push({ action: 'delete', path: existing.path, sha: existing.sha, flowId: flow.id })
    }
  }
  return changes
}

export interface PullChange {
  action: 'create' | 'update'
  flowId: string
  path: string
  flow: Record<string, unknown> | null
}

/** What pulling the repository into the workspace would change. */
export function pullPlan(flows: LocalFlow[], remote: RemoteFile[]): PullChange[] {
  const local = new Map(flows.map((flow) => [flow.id, flow]))
  const changes: PullChange[] = []

  for (const file of remote) {
    const id = flowIdFromFile(file.content)
    // Not one of ours: a README, a broken file, anything else in the repo.
    if (!id) continue

    const parsed = JSON.parse(file.content) as Record<string, unknown>
    const existing = local.get(id)

    if (!existing) {
      changes.push({ action: 'create', flowId: id, path: file.path, flow: parsed })
      continue
    }

    // Compare against what the local flow WOULD serialize to, so the same
    // determinism that makes a push a no-op makes a pull one too. Identity is
    // the id inside the file, so a rename upstream updates rather than
    // duplicating.
    if (flowFileContent(existing) !== file.content) {
      changes.push({ action: 'update', flowId: id, path: file.path, flow: parsed })
    }
  }
  return changes
}
