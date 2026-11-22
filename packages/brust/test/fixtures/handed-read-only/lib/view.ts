import { LOOK_CHECK } from './checks'

// Reads a table no module writes.
export function viewOf(n: number): string {
  return LOOK_CHECK.a(n) ? 'one' : 'other'
}
