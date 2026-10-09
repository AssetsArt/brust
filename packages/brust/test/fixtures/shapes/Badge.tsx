// useReducer ⇒ react tier; rendered once per row of the parent's list.
import { useReducer } from 'react'

export default function Badge(props: { label: string }) {
  const [n, bump] = useReducer((x: number) => x + 1, 0)
  return (
    <b onClick={bump}>
      {props.label}:{n}
    </b>
  )
}
