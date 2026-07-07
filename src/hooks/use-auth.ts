'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSupabase } from '@/components/providers/supabase-provider'

type AuthContext = {
  userId: string
  organizationId: string
  role: string
}

export function useAuth() {
  const { user, loading, signOut } = useSupabase()
  const [context, setContext] = useState<AuthContext | null>(null)
  const [contextLoading, setContextLoading] = useState(false)

  useEffect(() => {
    if (!user) {
      setContext(null)
      return
    }
    const metadataOrganization = user.user_metadata?.organization_id
    if (metadataOrganization) {
      setContext({
        userId: user.id,
        organizationId: metadataOrganization,
        role: user.user_metadata?.role || 'USER',
      })
      return
    }

    setContextLoading(true)
    fetch('/api/auth/context', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => setContext(data.success ? data.context : null))
      .finally(() => setContextLoading(false))
  }, [user])

  return useMemo(() => ({
    isLoaded: !loading && !contextLoading,
    isSignedIn: Boolean(user),
    userId: user?.id || null,
    user: user ? {
      id: user.id,
      firstName: user.user_metadata?.first_name || user.user_metadata?.full_name?.split(' ')[0] || 'User',
      lastName: user.user_metadata?.last_name || '',
      emailAddress: user.email || '',
    } : null,
    loading: loading || contextLoading,
    signIn: () => { window.location.href = '/auth/login' },
    signUp: () => { window.location.href = '/auth/signup' },
    signOut: async () => {
      await signOut()
      window.location.href = '/auth/login'
    },
    isAdmin: context?.role === 'ADMIN',
    role: context?.role || null,
    organizationId: context?.organizationId || null,
    needsOrganizationSetup: Boolean(user && !context && !contextLoading),
  }), [context, contextLoading, loading, signOut, user])
}
