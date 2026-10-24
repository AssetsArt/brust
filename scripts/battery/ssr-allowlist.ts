// F386: rows whose served first HTML (or boot) is known to differ from React's, each with its F row. An entry is REMOVED by the
// lane that fixes the row: the gate is red on an entry that no longer differs, so a fix cannot leave its entry behind.
export interface Allowed { row: string; why: string }

export const ALLOWED: Record<string, Allowed> = {
  'c-usestate-load': { row: 'F418', why: 'useState(load) with a module function paints the button empty, React paints 42' },
  'c-usecontext': { row: 'F419', why: 'a createContext default read with no Provider is not painted, React paints it' },
  'b-spread-alias-known': { row: 'F422', why: 'className + class spread: React keeps both (the first wins in the browser), brust paints the last' },
}
