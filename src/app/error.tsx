'use client'

import { useEffect } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error('Route error', error) }, [error])
  return <div className="flex min-h-[60vh] items-center justify-center p-6"><Card className="w-full max-w-lg border-red-200"><CardHeader><CardTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-red-600" />This page could not be loaded</CardTitle></CardHeader><CardContent className="space-y-4"><p className="text-sm text-muted-foreground">Your saved data was not changed. Retry the page, or return to the dashboard.</p><div className="flex flex-wrap gap-2"><Button onClick={reset}><RefreshCw className="mr-1.5 h-4 w-4" />Try again</Button><Button variant="outline" onClick={() => { window.location.href = '/agents' }}>Agents</Button></div></CardContent></Card></div>
}
