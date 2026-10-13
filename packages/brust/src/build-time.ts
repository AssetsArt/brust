// `buildTime(() => …)`: the explicit opt-in to evaluate a pure call once, at `brust build` (L2/H1).
// The compiler recognises the call only when it is imported from `@brust/core`; the closure may be
// `async` and may use package imports. At runtime (a per-request job, the server) it just runs the
// closure, so behaviour is identical wherever it is not folded away at build. It is a build error
// in code that reaches the browser.

/** Runs `fn`. At build the compiler evaluates it once and bakes the result into the template. */
export function buildTime<T>(fn: () => T): T {
  return fn()
}
