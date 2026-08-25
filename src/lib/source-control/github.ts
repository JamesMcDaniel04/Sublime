import { fetchPublicUrl } from '@/lib/net/ssrf'
import type { RemoteFile, PushChange } from './sync-plan'

/**
 * The GitHub half of source control.
 *
 * Uses the REST Contents/Git APIs rather than a git binary or an embedded git
 * implementation: there is no git available in the serverless runtime, and
 * adding one to move a handful of JSON files would be a large dependency for
 * a small job. The cost is that this is GitHub-specific rather than working
 * against any SSH remote — a real narrowing, and the honest trade for shipping
 * something that works in the environment we actually run in.
 *
 * Unlike the secret-store client, this DOES go through the SSRF guard: the
 * host is api.github.com, a public endpoint by definition, so nothing
 * legitimate is blocked by refusing private addresses.
 */

const API = 'https://api.github.com'

export interface RepoBinding {
  /** `owner/name`. */
  repo: string
  branch: string
  token: string
}

export class SourceControlError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

function headers(binding: RepoBinding): Record<string, string> {
  return {
    authorization: `Bearer ${binding.token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'sublime-source-control',
  }
}

async function call(binding: RepoBinding, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetchPublicUrl(`${API}${path}`, {
    ...init,
    headers: { ...headers(binding), ...(init.headers as Record<string, string> | undefined) },
  })
  if (response.status === 401 || response.status === 403) {
    throw new SourceControlError('The access token was refused by GitHub.', response.status)
  }
  return response
}

/** Whether the binding works, checked before anything is written. */
export async function verifyRepo(binding: RepoBinding): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await call(binding, `/repos/${binding.repo}/branches/${encodeURIComponent(binding.branch)}`)
    if (response.status === 404) {
      return { ok: false, error: 'That repository or branch was not found, or the token cannot see it.' }
    }
    if (!response.ok) return { ok: false, error: `GitHub returned ${response.status}.` }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof SourceControlError ? error.message : 'GitHub could not be reached.' }
  }
}

/**
 * Every flow file currently in the repository.
 *
 * Reads the tree once rather than listing a directory and fetching each file:
 * a workspace with 200 flows would otherwise be 201 round trips.
 */
export async function listFlowFiles(binding: RepoBinding): Promise<RemoteFile[]> {
  const tree = await call(binding, `/repos/${binding.repo}/git/trees/${encodeURIComponent(binding.branch)}?recursive=1`)
  if (tree.status === 404) return []
  if (!tree.ok) throw new SourceControlError(`GitHub returned ${tree.status} listing the repository.`, tree.status)

  const body = await tree.json() as { tree?: { path: string; type: string; sha: string }[] }
  const entries = (body.tree ?? []).filter(
    (entry) => entry.type === 'blob' && entry.path.startsWith('flows/') && entry.path.endsWith('.json'),
  )

  const files: RemoteFile[] = []
  for (const entry of entries) {
    const blob = await call(binding, `/repos/${binding.repo}/git/blobs/${entry.sha}`)
    if (!blob.ok) continue
    const data = await blob.json() as { content?: string; encoding?: string }
    if (data.encoding !== 'base64' || typeof data.content !== 'string') continue
    files.push({
      path: entry.path,
      content: Buffer.from(data.content, 'base64').toString('utf8'),
      // The BLOB sha, which is what the Contents API needs to replace a file.
      sha: entry.sha,
    })
  }
  return files
}

/**
 * Apply a push plan.
 *
 * One commit per file, which is what the Contents API offers without building
 * a tree by hand. The trade-off is real: a push of twenty flows is twenty
 * commits rather than one. Worth naming, and worth revisiting with the Git
 * Trees API if pushes get large.
 *
 * A failure stops the run rather than continuing: a half-applied push is
 * confusing, and stopping leaves the repository in a state the next push can
 * simply complete.
 */
export async function applyPush(
  binding: RepoBinding,
  changes: PushChange[],
  message: string,
): Promise<{ applied: number }> {
  let applied = 0
  for (const change of changes) {
    const path = `/repos/${binding.repo}/contents/${change.path.split('/').map(encodeURIComponent).join('/')}`

    const response = await call(binding, path, {
      method: change.action === 'delete' ? 'DELETE' : 'PUT',
      body: JSON.stringify({
        message: `${message} (${change.action} ${change.path})`,
        branch: binding.branch,
        ...(change.action === 'delete'
          ? { sha: change.sha }
          : {
              content: Buffer.from(change.content ?? '', 'utf8').toString('base64'),
              // Present only for an update — sending a sha on a create is an
              // error, and omitting it on an update would clobber whatever
              // someone else pushed in between.
              ...(change.sha ? { sha: change.sha } : {}),
            }),
      }),
    })

    if (!response.ok) {
      throw new SourceControlError(
        `GitHub refused to ${change.action} ${change.path} (HTTP ${response.status}). ${applied} of ${changes.length} changes were applied.`,
        response.status,
      )
    }
    applied++
  }
  return { applied }
}
