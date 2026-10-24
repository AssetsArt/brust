import { useState } from 'react'
import { Select, Textarea } from './Controls'

// F432: a select and textarea whose value reaches the element through a spread (the shadcn wrapper shape). The values are
// fixed at the call site (a value that changes on the client through a spread keeps the page on React, which is another
// row); the handler counts clicks so the page is interactive.
export default function SpreadPage() {
  const [n, setN] = useState(0)
  return (
    <main>
      <Select data-testid="wrap-select" value="b" onChange={() => setN(n + 1)}>
        <option value="a">A</option>
        <option value="b">B</option>
        <option value="c">C</option>
      </Select>
      <p data-testid="wrap-echo">{n}</p>
      <Select data-testid="wrap-default" defaultValue="c">
        <option value="a">A</option>
        <option value="c">C</option>
      </Select>
      <Select data-testid="wrap-many" multiple value={['a', 'c']} onChange={() => setN(n + 1)}>
        <option value="a">A</option>
        <option value="b">B</option>
        <option value="c">C</option>
      </Select>
      <Textarea data-testid="wrap-ta" value={'a<b & "c"'} onChange={() => setN(n + 1)} />
      <Textarea data-testid="wrap-ta-default" defaultValue="d" />
      <Textarea data-testid="wrap-ta-plain" />
    </main>
  )
}
