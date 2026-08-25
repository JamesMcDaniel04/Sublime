import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PUBLIC_PATHS, isPublicPath } from '../public-paths'

const PUBLIC_GROUP = new URL('../../../app/(public)', import.meta.url).pathname

/** Every route under the (public) group, as the URL path it serves. */
function routesOnDisk(dir = PUBLIC_GROUP, prefix = ''): string[] {
  const routes: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name === 'page.tsx' || entry.name === 'route.ts')) {
      routes.push(prefix || '/')
    } else if (entry.isDirectory()) {
      routes.push(...routesOnDisk(join(dir, entry.name), `${prefix}/${entry.name}`))
    }
  }
  return routes
}

// The (public) route group is the real definition of "a signed-out visitor may
// see this". Middleware cannot read the filesystem at the edge, so the list is
// written out by hand — which is exactly how the previous two copies drifted.
// This closes the loop: add a page under (public) and forget to list it, and
// the suite fails here instead of the route quietly redirecting visitors to
// sign-in.
test('every route in the (public) group is allow-listed', () => {
  // Checked through isPublicPath rather than PUBLIC_PATHS directly, because
  // that is the function middleware actually calls — and it is the only one
  // that understands a dynamic route. A page at /f/[id] is never a literal
  // member of the set; it is covered by a prefix, and a test reading the raw
  // set would demand an entry that cannot exist.
  const missing = routesOnDisk().filter((route) => {
    // Concretise dynamic segments the way a real request would.
    const concrete = route.replace(/\[[^\]]+\]/g, 'sample-id')
    return !isPublicPath(concrete)
  })
  assert.deepEqual(missing, [], `public routes missing from PUBLIC_PATHS: ${missing.join(', ')}`)
})

test('the allow-list contains no paths that no longer exist', () => {
  const onDisk = new Set(routesOnDisk())
  const stale = [...PUBLIC_PATHS].filter((route) => !onDisk.has(route))
  assert.deepEqual(stale, [], `allow-listed paths with no route on disk: ${stale.join(', ')}`)
})

test('marketing pages are public to the client guard, so a refocused tab is not bounced', () => {
  // The regression: these were absent from the client copy, so backgrounding
  // and refocusing a tab on /about bounced a signed-out reader to sign-in.
  for (const path of ['/', '/about', '/contact', '/privacy', '/terms']) {
    assert.equal(isPublicPath(path), true, `${path} should be public`)
  }
})

test('authenticated routes stay protected', () => {
  for (const path of ['/g/all/dashboard', '/settings', '/activity', '/skills/abc']) {
    assert.equal(isPublicPath(path), false, `${path} should be protected`)
  }
})

// ── the public form page ────────────────────────────────────────────────────
//
// A form-triggered flow is submitted by someone outside the workspace, so its
// page cannot require a session. It is safe to expose because the page renders
// nothing and holds nothing — every byte comes from an API call authorised by
// the per-flow trigger token.

test('a form submission page is public', () => {
  assert.equal(isPublicPath('/f/clx123abc'), true)
})

// The prefix must not accidentally open anything else that starts with f.
test('the form prefix does not open unrelated paths', () => {
  assert.equal(isPublicPath('/flows'), false)
  assert.equal(isPublicPath('/flows/clx123abc'), false)
  assert.equal(isPublicPath('/feed'), false)
})

test('an authenticated area is still private', () => {
  assert.equal(isPublicPath('/settings'), false)
  assert.equal(isPublicPath('/agents'), false)
})
