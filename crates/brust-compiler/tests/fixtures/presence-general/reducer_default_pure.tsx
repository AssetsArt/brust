import { useReducer } from 'react'
export default function P() {
  const [c, dispatch] = useReducer((s: number, a: number = 1, { by = 2 }: { by?: number } = {}) => s + a + by, 0)
  return <button type="button" onClick={() => dispatch(1)}>{c}</button>
}
