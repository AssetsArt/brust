// A `.ts` module with a generic arrow (no trailing comma): it does not parse as TSX, it does as TypeScript (F599 O3).
import { LOOK_CHECK } from './checks'

const clone = <T>(v: T): T => v
// Only reads `table`: handing the import here is not a write (F614).
function checkKeys(set: unknown, table: Readonly<Record<string, unknown>>): string | null {
  return Object.keys(set as object).find((k) => !Object.hasOwn(table, k)) ?? null
}
export const checkLook = (set: unknown) => checkKeys(clone(set), LOOK_CHECK)
export * from './checks'
