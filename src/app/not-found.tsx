import Link from 'next/link'
import { Button } from '@/components/ui/button'

export default function NotFound() {
  return <main className="flex min-h-[70vh] items-center justify-center p-6"><div className="max-w-md text-center"><p className="eyebrow">404</p><h1 className="mt-2 text-2xl font-semibold">Page not found</h1><p className="mt-2 text-sm text-muted-foreground">The link may be outdated, or you may not have access to this workspace item.</p><Button className="mt-5" asChild><Link href="/agents">Open your agents</Link></Button></div></main>
}
