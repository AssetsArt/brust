// Server-only (node:fs): used by the loader and in render (a precompute job), never by client code.
import { existsSync } from 'node:fs'
export const label = (s: string) => `${s}:${existsSync('/') ? 'fs' : 'nofs'}`
