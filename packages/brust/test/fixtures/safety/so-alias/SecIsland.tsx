// React tier: `@sec` is a tsconfig `paths` alias of lib/secret.server.ts (a `*.server.*` file).
import { SECRET } from '@sec'
import { useReducer, useTransition } from 'react'

export default function SecIsland() {
  useTransition()
  const [n, bump] = useReducer((x: number) => x + 1, 0)
  return (
    <b onClick={bump} title={SECRET.slice(0, 2)}>
      {n}
    </b>
  )
}
