/** Pure goal→template matching. Order-in = order-out; ranking (adoption,
 * readiness) is composed by callers, same as the other relevance sorts. */
import { SEED_CATALOGUE, type SeedTemplate } from './catalogue'

export function goalTemplatesFor(
  kind: string,
  seeds: SeedTemplate[] = SEED_CATALOGUE,
): SeedTemplate[] {
  return seeds.filter((seed) => (seed.goalKinds ?? []).includes(kind))
}
