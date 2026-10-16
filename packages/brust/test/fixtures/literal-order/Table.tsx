import { useState } from 'react'

// A native child (it has state, so it is not folded into the page): `cfg` is a literal of the page, read with
// Object.entries / Object.keys.
export default function Table({ cfg, id }: { cfg: Record<string, string>; id: string }) {
  const [n, setN] = useState(0)
  return (
    <section data-testid={id}>
      <button type="button" onClick={() => setN(n + 1)}>
        {n}
      </button>
      <ul>
        {Object.entries(cfg).map((e) => (
          <li key={e[0]}>
            {e[0]}={e[1]}
          </li>
        ))}
      </ul>
      <i>{Object.keys(cfg).join(',')}</i>
    </section>
  )
}
