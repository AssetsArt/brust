import { useReducer } from 'react'
let n = 0
const tick = () => (n += 1)
export default function P() {
  const [xs, dispatch] = useReducer((s: number[], a: number) => s.map(function (x, i = tick()) { return x + i }).concat(a), [] as number[])
  return <button type="button" onClick={() => dispatch(1)}>{xs.length > 0 ? 'some' : 'none'}</button>
}
