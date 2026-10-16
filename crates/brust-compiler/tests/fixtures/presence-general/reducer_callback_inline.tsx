import { useReducer } from 'react'
export default function P() {
  const [xs, dispatch] = useReducer((s: number[], a: number) => s.map((n) => n + 1).filter((n) => n > 0).concat(a), [] as number[])
  return <button type="button" onClick={() => dispatch(1)}>{xs.length > 0 ? 'some' : 'none'}</button>
}
