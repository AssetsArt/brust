// React tier: the whole file ships as an island, so a value import of `@brust/core/server` would ship too.
import { cache } from '@brust/core/server'
import { useReducer, useTransition } from 'react'

export default function Island(props: { label: string }) {
  useTransition()
  const [n, bump] = useReducer((x: number) => x + 1, 0)
  return (
    <b onClick={() => { bump(); cache.invalidate({ key: 'x' } as never) }}>
      {props.label}:{n}
    </b>
  )
}
