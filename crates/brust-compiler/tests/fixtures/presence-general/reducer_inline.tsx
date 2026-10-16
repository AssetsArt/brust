import { useReducer } from 'react'
export default function P() {
  const [n, dispatch] = useReducer((s: number, a: number) => s + a, 0)
  return <button type="button" onClick={() => dispatch(2)}>{`${n}`}</button>
}
