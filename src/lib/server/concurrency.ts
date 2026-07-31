/**
 * Bounded-parallel map. Runs `fn` over `items` with at most `limit` in flight
 * at once — the cron tick's per-org fan-outs use this instead of launching an
 * unbounded promise per org, which contended hundreds of pipelines against a
 * connection_limit=1 Prisma pool the moment the org count grew.
 *
 * Rejections are contained per item (returned as `{ ok: false, error }`), so
 * one failing org can never abort the sweep for the rest.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  if (limit < 1) throw new Error(`mapWithConcurrency: limit must be >= 1, got ${limit}`)
  const results: Array<{ ok: true; value: R } | { ok: false; error: unknown }> = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      try {
        results[index] = { ok: true, value: await fn(items[index], index) }
      } catch (error) {
        results[index] = { ok: false, error }
      }
    }
  })
  await Promise.all(workers)
  return results
}
