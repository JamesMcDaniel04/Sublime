import { Suspense } from 'react'
import type { Metadata } from 'next'
import { FormRunner } from './form-runner'

/**
 * The public page a form-triggered flow is submitted from.
 *
 * Lives under (public) with no auth: the whole point is that someone outside
 * the workspace can fill it in. Authorisation is the per-flow trigger token in
 * the query string, which is why the API refuses without it — see
 * api/flows/[id]/form/route.ts for why the token travels this way.
 *
 * The page renders nothing itself and holds no secrets. Fields are fetched
 * client-side with the token, so the token never has to be embedded in
 * server-rendered HTML that a proxy or a browser cache might retain.
 */

export const metadata: Metadata = {
  title: 'Submit a form',
  // A form URL is shared in emails and chats; indexing one would put every
  // workspace's intake form in a search engine, token and all.
  robots: { index: false, follow: false },
}

export default async function FormPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-4 py-12">
      {/* Required: FormRunner reads the token with useSearchParams, which
          App Router refuses to prerender without a boundary. */}
      <Suspense fallback={<p className="text-center text-sm text-muted-foreground">Loading…</p>}>
        <FormRunner flowId={id} />
      </Suspense>
    </main>
  )
}
