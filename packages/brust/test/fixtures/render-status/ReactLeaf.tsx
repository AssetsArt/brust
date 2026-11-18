// useTransition => React tier: the page renders through an ssr job (served as an island).
import { useReducer, useTransition } from 'react'

export default function ReactLeaf(props: { title: string; why?: string }) {
  useTransition()
  const [n, bump] = useReducer((x: number) => x + 1, 0)
  return (
    <article data-page={props.title} data-tier="react">
      <h1>{props.title}</h1>
      <p data-why>{props.why ?? ''}</p>
      <button type="button" onClick={bump}>
        {n}
      </button>
    </article>
  )
}
