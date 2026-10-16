import { useReducer } from 'react'
import { effectful } from './reducer_ext'
export default function P() {
  const [n, dispatch] = useReducer((s: number, a: number) => effectful(s, a), 0)
  return <button type="button" onClick={() => dispatch(1)}>{`${n}`}</button>
}
