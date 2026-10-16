import { useReducer } from 'react'
let n = 0
const tick = () => (n += 1)
export default function P() {
  const [c, dispatch] = useReducer((s: number, a: number = tick()) => s + a, 0)
  return <button type="button" onClick={() => dispatch(1)}>{c}</button>
}
