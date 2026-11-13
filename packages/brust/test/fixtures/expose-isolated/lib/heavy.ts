// A module both the component and the exposed `shop/sdk.ts` import (the research repro: a big shared dependency).
// How many times this module was evaluated in the page: isolated, each side has its own copy, so 2.
export const heavyLoads = ((globalThis as { __heavyLoads?: number }).__heavyLoads = ((globalThis as { __heavyLoads?: number }).__heavyLoads ?? 0) + 1)
export const HEAVY = 'heavy-marker-' + 'x'.repeat(64)
export const heavy = (n: number) => `${HEAVY}:${n}`
