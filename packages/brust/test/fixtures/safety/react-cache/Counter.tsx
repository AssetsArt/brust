// A react island that imports `cache` from the package root (browser-safe entry).
import { cache } from '@brust/core'
import { useReducer } from 'react'

function Counter(props: { label: string }) {
  const [n, bump] = useReducer((x: number) => x + 1, 0)
  return (
    <b onClick={bump}>
      {props.label}:{n}
    </b>
  )
}

export default cache(Counter, { revalidate: 10 })
