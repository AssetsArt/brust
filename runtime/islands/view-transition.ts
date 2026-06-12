// Opt-in View Transitions for SPA navigation. The framework default is an
// INSTANT swap; an app opts in by putting `data-brust-view-transitions` on
// <html> and shipping the `::view-transition-*(root)` CSS itself. The helper is
// pure (takes `doc`) so it unit-tests without a real browser. Spec:
// docs/superpowers/specs/2026-06-12-view-transitions-design.md

/** True iff this navigation should animate: the browser supports the View
 *  Transitions API AND the app opted in with the <html> marker. */
export function viewTransitionsEnabled(doc: Document): boolean {
  return (
    typeof (doc as { startViewTransition?: unknown }).startViewTransition === 'function' &&
    doc.documentElement.hasAttribute('data-brust-view-transitions')
  )
}

/** Run the synchronous navigation `commit` inside a view transition when
 *  enabled, else directly. Resolves once the DOM is committed (NOT when the
 *  animation finishes) so caller ordering is preserved. `commit` runs EXACTLY
 *  once on every path:
 *   - disabled/unsupported → direct call
 *   - startViewTransition throws synchronously (before the callback) → direct
 *     call (the swap never happened — losing it would blank the page, B2)
 *   - updateCallbackDone rejects (the callback ran-and-threw) → NOT re-run; the
 *     rejection PROPAGATES so the caller can run its full-reload recovery. */
export async function withViewTransition(doc: Document, commit: () => void): Promise<void> {
  if (!viewTransitionsEnabled(doc)) {
    commit()
    return
  }
  const start = (
    doc as Document & {
      startViewTransition: (cb: () => void) => { updateCallbackDone: Promise<void> }
    }
  ).startViewTransition
  let tr: { updateCallbackDone: Promise<void> }
  try {
    tr = start.call(doc, commit)
  } catch {
    commit()
    return
  }
  // `updateCallbackDone` rejects ONLY when the update callback (`commit`) threw
  // — animation failures surface on `.finished`, which we never await. So a
  // rejection means the DOM may be half-committed: propagate it (do NOT re-run
  // `commit`) so the caller's catch runs its error path (`__navError` +
  // full-reload), exactly as the synchronous direct-commit branch does. A
  // transition that is merely SKIPPED (a newer startViewTransition) still
  // resolves `updateCallbackDone`, so this never throws on supersession.
  await tr.updateCallbackDone
}
