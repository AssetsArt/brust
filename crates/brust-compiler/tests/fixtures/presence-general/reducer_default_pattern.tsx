import { useReducer } from 'react'
let n = 0
const tick = () => (n += 1)
export default function P() {
  const [c, dispatch] = useReducer((s: number, a: { by?: number }) => {
    const { by = tick() } = a
    return s + by
  }, 0)
  return <button type="button" onClick={() => dispatch({})}>{c}</button>
}
