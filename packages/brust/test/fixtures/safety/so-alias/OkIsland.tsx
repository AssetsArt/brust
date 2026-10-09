// React tier: `@ok` is a tsconfig `paths` alias of a plain (browser-safe) module.
import { GREETING } from '@ok'
import { useReducer } from 'react'

export default function OkIsland() {
  const [n, bump] = useReducer((x: number) => x + 1, 0)
  return (
    <b onClick={bump}>
      {GREETING}:{n}
    </b>
  )
}
