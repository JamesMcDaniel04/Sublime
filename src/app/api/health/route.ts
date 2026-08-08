import { NextResponse } from 'next/server'
import { collectHealthDetails } from '@/lib/health/readiness'
import { apiLogger } from '@/lib/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type PublicHealth = { status: 'ok' | 'unhealthy'; timestamp: string }
let cached: { at: number; body: PublicHealth; httpStatus: number } | null = null
const HEALTH_CACHE_MS = 10_000

/** Public load-balancer probe: deliberately no dependency names, errors,
 * latency, queue depth, or dead-letter counts. */
export async function GET() {
  if (cached && Date.now() - cached.at < HEALTH_CACHE_MS) {
    return NextResponse.json(cached.body, { status: cached.httpStatus })
  }
  const details = await collectHealthDetails()
  const body: PublicHealth = { status: details.status, timestamp: details.timestamp }
  const httpStatus = details.status === 'ok' ? 200 : 503
  cached = { at: Date.now(), body, httpStatus }
  if (details.status !== 'ok') {
    apiLogger.warn('public health probe unhealthy', { checks: details.checks })
  }
  return NextResponse.json(body, { status: httpStatus })
}
