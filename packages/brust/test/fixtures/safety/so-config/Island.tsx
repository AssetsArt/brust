// React tier (useReducer): the whole file ships, so DB_URL read in render ships with it; only the
// browser bundle sees that (the compiler checks client code: handlers, effects).
import { useReducer } from 'react'
import { DB_URL } from './lib/server/db'

export default function Island() {
  const [n, bump] = useReducer((x: number) => x + 1, 0)
  return (
    <b onClick={bump} title={DB_URL.slice(0, 2)}>
      {n}
    </b>
  )
}
