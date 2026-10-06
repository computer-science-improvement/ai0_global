/**
 * What a 401 from the API does (spec 028 FR-012): forget the cached session,
 * then send the browser to `/login?next=…&reason=…` — ONCE, however many
 * requests fail together (single-flight). Outside `/app` (landing, public
 * report pages) nothing navigates. Router-agnostic so it can be unit-tested;
 * `router.ts` wires it to the real router and query client.
 */
export interface UnauthorizedDeps {
  /** Mark the session as gone (so `/login` doesn't bounce back to `/app`). */
  resetSession: (reason: string | null) => void;
  navigateToLogin: (search: { next?: string; reason?: string }) => Promise<unknown>;
  /** Router-relative href of the current location (`/app/editor?x=1`). */
  currentHref: () => string;
}

export function createUnauthorizedHandler(deps: UnauthorizedDeps): (reason: string | null) => void {
  let inFlight = false;
  return (reason) => {
    deps.resetSession(reason);
    if (inFlight) return;
    const href = deps.currentHref();
    if (!/^\/app(?:[/?#]|$)/.test(href)) return;
    inFlight = true;
    void Promise.resolve()
      .then(() => deps.navigateToLogin({ next: href, ...(reason ? { reason } : {}) }))
      .catch(() => undefined)
      .finally(() => { inFlight = false; });
  };
}
