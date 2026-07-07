'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { AlertCircle, ArrowRight, Check } from 'lucide-react'

/**
 * The entitlement gate's front door. Signed-in users without an active
 * Den Sales AI connection land here; connecting runs the Den MCP
 * OAuth flow (Glass → Salesforce) and unlocks the workspace.
 */
function ConnectInner() {
  const params = useSearchParams()
  const status = params.get('peopleai')

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-horizon-soft p-6">
      <div className="w-full max-w-md animate-fade-in-up rounded-xl border bg-white p-8 shadow-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/den-lockup-black.svg" alt="Den" className="h-6 w-auto" />

        <p className="eyebrow mt-8">Sales AI required</p>
        <h1 className="mt-2 text-2xl font-semibold text-gray-900">
          Connect your Den account
        </h1>
        <p className="mt-3 text-sm leading-6 text-gray-600">
          Den Studio is available to Den Sales AI customers. Sign in
          with your Salesforce identity to link this workspace to your team —
          your agents will read Sales AI with your own permissions.
        </p>

        {status === 'error' && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>The connection didn&apos;t complete. Try again — if it keeps failing, contact support.</p>
          </div>
        )}
        {status === 'team-mismatch' && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>This workspace belongs to a different Den team. Ask your workspace admin, or sign in with the matching account.</p>
          </div>
        )}
        {status === 'state-mismatch' && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>The sign-in attempt expired. Start the connection again.</p>
          </div>
        )}
        {status === 'connected' && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-900">
            <Check className="mt-0.5 h-4 w-4 shrink-0" />
            <p>Connected. You can head to your dashboard.</p>
          </div>
        )}

        <a
          href="/api/peopleai/connect?return_to=/dashboard"
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white shadow-1 transition-all duration-fast ease-out-quart hover:bg-gray-800 hover:shadow-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-[0.98]"
        >
          Connect Den <ArrowRight className="h-4 w-4" />
        </a>

        <p className="mt-4 text-xs leading-5 text-gray-400">
          You&apos;ll authenticate with Salesforce through Den. Den
          only receives tokens scoped to your permissions — no passwords.
        </p>
      </div>
    </main>
  )
}

export default function ConnectPage() {
  return (
    <Suspense fallback={null}>
      <ConnectInner />
    </Suspense>
  )
}
