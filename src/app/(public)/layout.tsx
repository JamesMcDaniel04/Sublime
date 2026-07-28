/**
 * Marketing, legal, and auth routes. No billing gate and no app chrome — this
 * exists so the (app) group can own the sidebar and the paywall without the
 * root layout having to guess which routes are which by pathname prefix.
 *
 * Adds no URL segment: /about is still /about, / is still /.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <main id="main-content">{children}</main>
}
