import { useReducer } from 'react'

// A React-tier component (useReducer): the page imports it as an island, so its server render is a worker call.
export default function Panel(props: { label: string }) {
  const [n, bump] = useReducer((x: number) => x + 1, 0)
  return (
    <button type="button" data-panel onClick={() => bump()}>
      {props.label} {n}
    </button>
  )
}
