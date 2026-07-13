type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Complete the server-side auth bootstrap before navigating into the app.
 * The endpoint resolves an existing membership, accepts a pending invitation,
 * or creates a new organization for the authenticated user. */
export async function ensureWorkspaceReady(fetcher: FetchLike = fetch): Promise<void> {
  const response = await fetcher('/api/auth/context', { cache: 'no-store' })
  const payload = await response.json().catch(() => null) as { error?: string } | null
  if (!response.ok) {
    throw new Error(payload?.error || 'Could not finish setting up your workspace. Please try again.')
  }
}
