// React islands: the server paints <brust-island data-id x-props>HTML</brust-island>; the island's
// chunk registers a hydrate function through a global queue (no import of the runtime); the runtime
// hydrates each host once, when idle (spec S12). Load order between runtime and chunks is free.
import { warnOnce, insideRaw } from './core-api'

/** Hydrates `host`. It may return a dispose function (the React shim returns `() => root.unmount()`): the runtime
 *  calls it once, when the host leaves the document, so effects clean up like a React route change. */
export type IslandHydrate = (host: HTMLElement, props: Record<string, unknown>) => void | (() => void)
type QueueEntry = [string, IslandHydrate]
declare global { var __brustIslands: QueueEntry[] | undefined; var __brustIslandReady: (() => void) | undefined }

// One entry per island id: the hydrate fn once registered, else the callbacks waiting for it.
const slots = new Map<string, IslandHydrate | Array<(h: IslandHydrate) => void>>()

export function defineIsland(id: string, hydrate: IslandHydrate): void {
  const w = slots.get(id)
  slots.set(id, hydrate)
  if (Array.isArray(w)) w.forEach((cb) => cb(hydrate))
}

/** Move every queued [id, hydrate] from the global array into the registry. Idempotent. */
function drain(): void {
  const q = (globalThis.__brustIslands ||= [])
  while (q.length) defineIsland(...q.shift()!)
  globalThis.__brustIslandReady = drain
}

export function whenIsland(id: string, cb: (h: IslandHydrate) => void): void {
  drain()
  const s = slots.get(id)
  if (typeof s === 'function') cb(s)
  else if (s) s.push(cb)
  else slots.set(id, [cb])
}

// ---- scheduler ----------------------------------------------------------------------------
type Idle = (cb: () => void) => void
/** Longest an island waits for an idle period. Without a timeout `requestIdleCallback` never fires while
 *  the main thread has no idle gap (a loaded runner, a throttled or hidden tab), and an island whose host
 *  is already painted would stay server HTML indefinitely. */
export const IDLE_TIMEOUT_MS = 250
const defaultIdle: Idle = (cb) => {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback
  if (typeof ric === 'function') ric(cb, { timeout: IDLE_TIMEOUT_MS }); else setTimeout(cb, 1)
}
let idle: Idle = defaultIdle
export function _setIdle(fn: Idle | null): void { idle = fn ?? defaultIdle }

const pending = new Set<HTMLElement>()
/** Dispose functions of hydrated hosts, until the host leaves the document. */
const live = new Map<HTMLElement, () => void>()

function readIslandProps(host: HTMLElement, id: string): Record<string, unknown> {
  const raw = host.getAttribute('x-props')
  if (!raw) return {}
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {} }
  catch { warnOnce(`ij:${id}:${raw.slice(0, 40)}`, `bad x-props JSON in island ${id}`); return {} }
}

function hydrateHost(host: HTMLElement, id: string, hydrate: IslandHydrate): void {
  pending.delete(host)
  if (!host.isConnected || host.hasAttribute('data-hydrated')) return
  try {
    const dispose = hydrate(host, readIslandProps(host, id))
    if (typeof dispose === 'function') live.set(host, dispose)
    host.setAttribute('data-hydrated', '1')
  }
  catch (e) { console.error(`[brust] hydrate threw: ${id}`, e) }
}

function scheduleHost(host: HTMLElement): void {
  if (insideRaw(host)) return   // inside dangerouslySetInnerHTML markup: never hydrated
  if (pending.has(host) || host.hasAttribute('data-hydrated')) return
  const id = host.getAttribute('data-id')!
  pending.add(host)
  whenIsland(id, (hydrate) => { if (pending.has(host)) idle(() => hydrateHost(host, id, hydrate)) })
}

/** Schedule every not-yet-hydrated island under `root` (inclusive). Called by mount() and the observer. */
export function scheduleIslands(root: ParentNode): void {
  if (root instanceof HTMLElement && root.tagName === 'BRUST-ISLAND' && root.hasAttribute('data-id')) scheduleHost(root)
  root.querySelectorAll<HTMLElement>('brust-island[data-id]').forEach(scheduleHost)
}

/** A subtree left the document: forget its pending hosts and unmount the roots of its hydrated ones. */
export function cancelIslands(root: Node): void {
  if (!(root instanceof Element)) return
  const hosts = root.querySelectorAll<HTMLElement>('brust-island[data-id]')
  const forget = (h: HTMLElement) => {
    pending.delete(h)
    const dispose = live.get(h)
    if (!dispose) return
    live.delete(h)
    try { dispose() } catch (e) { console.error('[brust] island unmount threw', e) }
  }
  if (root instanceof HTMLElement) forget(root)
  hosts.forEach(forget)
}

/** Test helper: forget registrations, waiters, pending hosts and the global queue. */
export function _resetIslands(): void {
  slots.clear(); pending.clear(); live.clear(); idle = defaultIdle
  globalThis.__brustIslands = []
  globalThis.__brustIslandReady = undefined
}
