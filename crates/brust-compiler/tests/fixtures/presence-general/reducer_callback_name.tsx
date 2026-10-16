import { useReducer } from 'react'
let calls = 0
function bump(n: number) { calls += 1; return n + 1 }
export default function P() {
  const [xs, dispatch] = useReducer((s: number[], a: number) => s.map(bump).concat(a), [] as number[])
  return <button type="button" onClick={() => dispatch(1)}>{xs.length > 0 ? 'some' : 'none'}</button>
}
