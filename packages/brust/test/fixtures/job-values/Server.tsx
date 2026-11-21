// F585: one job value in every position a template prints or tests it; an array of them read item by item.
import { f, g } from './values'

function Box({ label }: { label?: any }) {
  return <i data-testid="prop">{label}</i>
}

export default function Server({ x }: { x: string }) {
  const v = f(x)
  const vs = g(x)
  return (
    <div>
      <p data-testid="text" title={v} hidden={v} aria-hidden={v} data-v={v}>{v}</p>
      {v ? <b data-testid="test">T</b> : <i data-testid="test">F</i>}
      <Box label={v} />
      <ul>
        {vs.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  )
}
