import { useReducer } from 'react'
let calls = 0
function cmp(a: number, b: number) { calls += 1; return a - b }
export default function P() {
  const [xs, dispatch] = useReducer((s: number[], a: number) => s.concat(a).toSorted(cmp), [] as number[])
  return <button type="button" onClick={() => dispatch(1)}>{xs.length > 0 ? 'some' : 'none'}</button>
}
