// useReducer ⇒ react tier ⇒ ssr job on ItemPage.
import { useReducer, useTransition } from 'react'

export default function Team(props: { team: string[]; title: string }) {
  useTransition()
  const [n, bump] = useReducer((x: number) => x + 1, 0)
  return (
    <div className="team">
      <h3>{props.title}</h3>
      <button onClick={bump}>+{n}</button>
      {props.team.map((m) => (
        <span key={m}>{m}</span>
      ))}
    </div>
  )
}
