import { useReducer } from 'react'
let calls = 0
export default function P() {
  const [n, dispatch] = useReducer((s: number, a: number) => { calls += 1; return s + a }, 0)
  return <button type="button" onClick={() => dispatch(1)}>{`${n}`}</button>
}
