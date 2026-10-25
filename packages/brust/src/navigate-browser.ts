// `navigate()` in the browser: runs the SPA flow through the `nav` module (`Symbol.for('brust.nav')`, the same
// cross-chunk pattern as `brust.stores`) and resolves after `success` or `error`. Without `nav` it is a full load.
import type { NavigateOptions } from './navigate'

type Bridge = { navigate(url: string, opts?: NavigateOptions): Promise<void>; clearCache(): void }
const bridge = () => (globalThis as { [k: symbol]: Bridge | undefined })[Symbol.for('brust.nav')]

export function navigate(url: string, opts?: NavigateOptions): Promise<void> {
  const b = bridge()
  if (b) return b.navigate(url, opts)
  if (opts?.replace) location.replace(url)
  else location.assign(url)
  return Promise.resolve()
}

/** Drop every page the SPA navigation cache holds (design §10.1), e.g. after a mutation made outside `client()`. */
export function clearNavigationCache(): void {
  bridge()?.clearCache()
}
