// useReducer ⇒ react tier ⇒ ssr job on ItemPage.
import { useReducer } from 'react'

export default function Team(props: { team: string[] }) {
  const [n, bump] = useReducer((x: number) => x + 1, 0)
  return (
    <div className="team">
      <button onClick={bump}>+{n}</button>
      {props.team.map((m) => (
        <span key={m}>{m}</span>
      ))}
    </div>
  )
}
