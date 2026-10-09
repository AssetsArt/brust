// React islands: the server paints <brust-island data-id x-props>HTML</brust-island>; the island's
// chunk registers a hydrate function through a global queue (no import of the runtime); the runtime
// hydrates each host once, when idle (spec S12). Load order between runtime and chunks is free.
import { warnOnce } from './warn'

export type IslandHydrate = (host: HTMLElement, props: Record<string, unknown>) => void
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
const defaultIdle: Idle = (cb) => {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback
  if (typeof ric === 'function') ric(cb); else setTimeout(cb, 1)
}
let idle: Idle = defaultIdle
export function _setIdle(fn: Idle | null): void { idle = fn ?? defaultIdle }

const pending = new Set<HTMLElement>()

function readIslandProps(host: HTMLElement, id: string): Record<string, unknown> {
  const raw = host.getAttribute('x-props')
  if (!raw) return {}
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {} }
  catch { warnOnce(`ij:${id}:${raw.slice(0, 40)}`, `bad x-props JSON in island ${id}`); return {} }
}

function hydrateHost(host: HTMLElement, id: string, hydrate: IslandHydrate): void {
  pending.delete(host)
  if (!host.isConnected || host.hasAttribute('data-hydrated')) return
  try { hydrate(host, readIslandProps(host, id)); host.setAttribute('data-hydrated', '1') }
  catch (e) { console.error(`[brust] hydrate threw: ${id}`, e) }
}

function scheduleHost(host: HTMLElement): void {
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

/** Forget pending hosts under a subtree that left the document. */
export function cancelIslands(root: Node): void {
  if (!(root instanceof Element)) return
  if (root instanceof HTMLElement && pending.has(root)) pending.delete(root)
  root.querySelectorAll<HTMLElement>('brust-island[data-id]').forEach((h) => pending.delete(h))
}

/** Test helper: forget registrations, waiters, pending hosts and the global queue. */
export function _resetIslands(): void {
  slots.clear(); pending.clear(); idle = defaultIdle
  globalThis.__brustIslands = []
  globalThis.__brustIslandReady = undefined
}
