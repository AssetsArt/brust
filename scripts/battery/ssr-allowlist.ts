// F386: rows whose served first HTML (or boot) is known to differ from React's, each with its F row. An entry is REMOVED by the
// lane that fixes the row: the gate is red on an entry that no longer differs, so a fix cannot leave its entry behind.
export interface Allowed { row: string; why: string }

export const ALLOWED: Record<string, Allowed> = {
  'c-usestate-load': { row: 'F418', why: 'useState(load) with a module function paints the button empty, React paints 42' },
  'c-usecontext': { row: 'F419', why: 'a createContext default read with no Provider is not painted, React paints it' },
  'a-select-controlled': { row: 'F420', why: 'a controlled <select> paints value="a" and no selected option' },
  'a-textarea-controlled': { row: 'F421', why: 'a controlled <textarea> paints a value attribute, not its text' },
  'b-spread-alias-known': { row: 'F422', why: 'className + class spread: React keeps both (the first wins in the browser), brust paints the last' },
  'c-context-field-named-loop': { row: 'F423', why: 'a useState local named loop becomes {% set loop %}: brust start refuses to boot' },
  'b-fed-child-row-reading-inline': { row: 'F424', why: 'string + number in a row prop is a jinja + error: HTTP 500' },
  'b-jsx-const-child-imported-plain': { row: 'F425', why: 'a sibling module with `export const el = <b/>`: the worker has no jsx runtime (jsxDEV is not a function)' },
  'b-jsx-const-child-shadowed': { row: 'F425', why: 'same sibling JSX const module as above' },
  'b-jsx-const-child-provider-own': { row: 'F425', why: 'same sibling JSX const module as above' },
  'b-context-provider-field-element': { row: 'F425', why: 'same sibling JSX const module as above' },
}
