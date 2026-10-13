import { readFileSync } from 'node:fs'

export function size(): number {
  return readFileSync(import.meta.path).length
}
