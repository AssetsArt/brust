import { useReducer } from 'react'
export default function P() {
  const [xs, dispatch] = useReducer((s: number[], a: number) => s.concat(a).toSorted((x, y) => x - y), [] as number[])
  return <button type="button" onClick={() => dispatch(1)}>{xs.length > 0 ? 'some' : 'none'}</button>
}
