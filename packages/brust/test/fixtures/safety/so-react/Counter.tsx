// React tier: the whole file ships as an island, so `./db.server` would ship too.
import { useReducer } from 'react'
import { q } from './db.server'

export default function Counter(props: { label: string }) {
  const [n, bump] = useReducer((x: number) => x + 1, 0)
  return (
    <b onClick={() => { bump(); console.log(q()) }}>
      {props.label}:{n}
    </b>
  )
}
