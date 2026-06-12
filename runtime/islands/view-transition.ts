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
 *   - updateCallbackDone rejects (the callback ran-and-threw) → NOT re-run. */
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
  try {
    await tr.updateCallbackDone
  } catch {
    // Callback already ran and threw; re-running would double-commit. Swallow.
  }
}
