import { useReducer, useTransition } from 'react'
import { hits } from './store'

export default function Island() {
  useTransition()
  const [n, bump] = useReducer((x: number) => x + 1, 0)
  return <b onClick={bump}>island {n} {hits()}</b>
}
