/**
 * Shared constant for the OAuth authorization-code flow's state cookie.
 *
 * Lives outside `route.ts` because Next.js route modules may only export
 * HTTP handlers + route config — a plain named export there fails the
 * generated route type-check ("… is not a valid Route export field").
 * Both the start (STEP 1) and callback (STEP 2) routes import it from here.
 */
export const OAUTH_COOKIE = 'bmcp_oauth'
