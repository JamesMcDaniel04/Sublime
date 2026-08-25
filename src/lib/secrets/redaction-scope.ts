import { AsyncLocalStorage } from 'node:async_hooks'
import { redactSecrets } from './providers'

/**
 * Run-scoped secret redaction.
 *
 * A resolved external secret is a REAL value flowing through the graph, unlike
 * a vault credential (injected at the transport edge, never in the context).
 * So every value on its way to the database has to be scrubbed, and the place
 * that happens is `jsonValue` in execute-flow — one function shared by every
 * persistence site, and by every concurrent run.
 *
 * **Why AsyncLocalStorage and not a module-level set.** The worker runs several
 * flow jobs concurrently in one process. With module state, the first run to
 * finish would clear the secrets while another run was still writing, and that
 * run's secrets would be persisted in the clear — an intermittent, load-
 * dependent disclosure, which is the worst kind to discover in production.
 * ALS scopes the state to the async call tree, which is the actual boundary.
 *
 * Outside any scope this is the identity function, so nothing else in the
 * codebase changes behaviour by importing it.
 */
const store = new AsyncLocalStorage<string[]>()

/** Run `fn` with `secrets` scrubbed from anything passed to `redactForCurrentRun`. */
export function withSecretRedaction<T>(secrets: string[], fn: () => Promise<T>): Promise<T> {
  // No secrets means no scope: the overwhelming majority of runs reference no
  // external secret, and they should not pay for this at all.
  if (secrets.length === 0) return fn()
  return store.run(secrets, fn)
}

/** Scrub the current run's secrets from a value. Identity outside a run. */
export function redactForCurrentRun(value: unknown): unknown {
  const secrets = store.getStore()
  return secrets ? redactSecrets(value, secrets) : value
}
