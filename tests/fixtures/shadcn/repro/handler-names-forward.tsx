// F147: the handler <Btn> forwards through its spread is hoisted by the page; the page's own `_h2` (read on the
// client) keeps its name, so the forwarded handler takes another one (React: b +10, Btn +100, p shows n and 2n).
import { useState } from 'react'

function Btn({ className, ...props }: any) {
  return <button data-slot="button" className={className} {...props} />
}

export default function Page() {
  const [n, setN] = useState(0)
  const _h1 = () => setN(n + 10)
  const _h2 = n * 2
  return (
    <section>
      <b data-testid="b" onClick={_h1}>
        b
      </b>
      <Btn data-testid="btn" onClick={() => setN(n + 100)}>
        btn
      </Btn>
      <p data-testid="p">
        {n} {_h2}
      </p>
    </section>
  )
}
