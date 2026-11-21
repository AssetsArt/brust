// Case 13: load-time code (a global write): a chunk that bundles this module is carried on every page of its route.
;(globalThis as { __busy?: number }).__busy = ((globalThis as { __busy?: number }).__busy ?? 0) + 1
export const STEP = 1
