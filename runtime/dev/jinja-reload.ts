// Dev-only bridge for hot-reloading native-route `.jinja` templates.
//
// `brust dev` (cli/dev.ts) emits the native-route templates once at startup,
// then registers a callback here that re-emits them from the (now edited)
// source and reloads them into the minijinja env in the napi addon. The dev
// coordinator calls `reEmitJinja()` on every ts/html/islands hot reload so
// `native: true` routes pick up source edits instead of serving the stale
// template until the dev server is restarted. (The Rust side supports reload —
// see crates/brust/src/jinja.rs, RwLock not OnceLock.)
//
// A registry singleton (like worker-registry) rather than a direct import,
// because the producer (cli/dev.ts) and the consumer (the coordinator, wired in
// index.ts) live in different layers and only meet at runtime in `brust dev`.

let _reEmit: (() => Promise<void>) | null = null

/** Called once by `brust dev` after the initial native-template emit. */
export function registerJinjaReEmit(fn: () => Promise<void>): void {
  _reEmit = fn
}

/** Called by the dev coordinator on a ts/html/islands hot reload. No-op when no
 * callback is registered (e.g. unit tests, or an app with no native routes). */
export async function reEmitJinja(): Promise<void> {
  if (_reEmit) await _reEmit()
}

/** Test helper. */
export function _resetForTests(): void {
  _reEmit = null
}
