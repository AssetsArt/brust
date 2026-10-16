import { useReducer } from 'react'
function init(n: number) { return n * 2 }
const step = (s: number, a: number) => s + a
export default function P() {
  const [n, dispatch] = useReducer(step, 3, init)
  return <button type="button" onClick={() => dispatch(1)}>{`${n}`}</button>
}
