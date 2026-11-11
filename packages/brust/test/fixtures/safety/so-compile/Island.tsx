// React tier: the whole file ships as an island, so a value import of `@brust/core/compile` would ship too.
import { compileComponent } from '@brust/core/compile'
import { useReducer, useTransition } from 'react'

export default function Island(props: { label: string }) {
  useTransition()
  const [n, bump] = useReducer((x: number) => x + 1, 0)
  return (
    <b onClick={() => { bump(); void compileComponent({ source: '', filename: 'a.tsx' }) }}>
      {props.label}:{n}
    </b>
  )
}
