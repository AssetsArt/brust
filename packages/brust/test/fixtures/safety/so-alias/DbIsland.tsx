// React tier: `@db` is a tsconfig `paths` alias of lib/server/db.ts (a [build] server_only path).
import { DB_URL } from '@db'
import { useReducer, useTransition } from 'react'

export default function DbIsland() {
  useTransition()
  const [n, bump] = useReducer((x: number) => x + 1, 0)
  return (
    <b onClick={bump} title={DB_URL.slice(0, 2)}>
      {n}
    </b>
  )
}
