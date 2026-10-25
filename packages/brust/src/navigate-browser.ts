// `navigate()` in the browser: runs the SPA flow through the `nav` module (`Symbol.for('brust.nav')`, the same
// cross-chunk pattern as `brust.stores`) and resolves after `success` or `error`. Without `nav` it is a full load.
import type { NavigateOptions } from './navigate'

type Bridge = { navigate(url: string, opts?: NavigateOptions): Promise<void> }

export function navigate(url: string, opts?: NavigateOptions): Promise<void> {
  const bridge = (globalThis as { [k: symbol]: Bridge | undefined })[Symbol.for('brust.nav')]
  if (bridge) return bridge.navigate(url, opts)
  if (opts?.replace) location.replace(url)
  else location.assign(url)
  return Promise.resolve()
}
