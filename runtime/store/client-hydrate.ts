// runtime/store/client-hydrate.ts — apply a nav-payload snapshot to live client stores.
export function applyStoreSnapshot(snap: Record<string, Record<string, unknown>>): void {
  const w = window as unknown as {
    __BRUST_STORES__?: Record<string, { instance: Record<string, unknown> }>
  }
  const reg = w.__BRUST_STORES__
  if (!reg) return
  for (const [name, state] of Object.entries(snap)) {
    const entry = reg[name]
    if (!entry) continue // handle not defined yet on client → skip (initial-load <script> covers it)
    for (const key of Object.keys(state)) {
      const v = entry.instance[key] as { set?: (x: unknown) => void } | undefined
      if (v && typeof v.set === 'function') v.set(state[key])
    }
  }
}
