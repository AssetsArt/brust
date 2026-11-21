// F585: a job-computed bigint at the top level, in an array and nested in an object.
import { f } from './values'

export default function Page({ x }: { x: string }) {
  const v = f(x)
  const vs = [v, 1]
  const o = { n: v }
  return (
    <div>
      <p data-testid="text" title={v}>{v}</p>
      {v ? <b>T</b> : <i>F</i>}
      <ul>
        {vs.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
      <s>{o.n}</s>
    </div>
  )
}
