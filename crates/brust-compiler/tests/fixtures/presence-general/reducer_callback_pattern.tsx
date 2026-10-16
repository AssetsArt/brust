import { useReducer } from 'react'
let n = 0
const tick = () => (n += 1)
export default function P() {
  const [xs, dispatch] = useReducer((s: { by?: number }[], a: number) => s.map(({ by = tick() }) => by).map((by) => ({ by })).concat({ by: a }), [] as { by?: number }[])
  return <button type="button" onClick={() => dispatch(1)}>{xs.length > 0 ? 'some' : 'none'}</button>
}
