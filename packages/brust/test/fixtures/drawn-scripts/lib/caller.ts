import { bump } from './tidy'

// Case 13: calls app code at load: a chunk that bundles this module is carried on every page of its route.
export const FIRST = bump()
