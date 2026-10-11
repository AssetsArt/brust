import { useReducer } from 'react'
import { hits } from './store'

export default function Island() {
  const [n, bump] = useReducer((x: number) => x + 1, 0)
  return <b onClick={bump}>island {n} {hits()}</b>
}
