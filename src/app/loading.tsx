import { Skeleton } from '@/components/ui/skeleton'

export default function Loading() {
  return <div className="mx-auto w-full max-w-6xl space-y-5 p-6" aria-label="Loading page"><Skeleton className="h-8 w-64" /><Skeleton className="h-4 w-full max-w-xl" /><div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3"><Skeleton className="h-40" /><Skeleton className="h-40" /><Skeleton className="h-40" /></div></div>
}
