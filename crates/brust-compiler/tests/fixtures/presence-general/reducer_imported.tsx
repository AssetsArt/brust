import { useReducer } from 'react'
import { effectful } from './reducer_ext'
export default function P() {
  const [n, dispatch] = useReducer(effectful, 0)
  return <button type="button" onClick={() => dispatch(1)}>{`${n}`}</button>
}
