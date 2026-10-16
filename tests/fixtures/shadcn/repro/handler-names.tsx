// F147: the page binds names of its own that look like brust's hoisted handler names (`_h1`, `_h2`). The inline handler
// on <s> and the one forwarded through <Btn>'s spread are hoisted under other names, so each element keeps its own
// handler (React: b +10, s +1, Btn +100) and the chunk declares each name once.
import { useState } from 'react'

function Btn({ className, ...props }: any) {
  return <button data-slot="button" className={className} {...props} />
}

export default function Page() {
  const [n, setN] = useState(0)
  const _h1 = () => setN(n + 10)
  const _h2 = 'count'
  return (
    <section>
      <b data-testid="b" onClick={_h1}>
        b
      </b>
      <s data-testid="s" onClick={() => setN(n + 1)}>
        s
      </s>
      <Btn data-testid="btn" onClick={() => setN(n + 100)}>
        btn
      </Btn>
      <p data-testid="p">
        {_h2} {n}
      </p>
    </section>
  )
}
