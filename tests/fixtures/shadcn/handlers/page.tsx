// shadcn S1.3 (spread-handlers) Chromium fixture: a native page hands handlers to shadcn components that spread their
// props onto an element (Button without asChild, the real Input). The page binds them itself (R34.18): the
// components stay static, and the page's state updates on click and on input.
import { useState } from "react"
import { Input } from "../components/ui/input"
import { Button } from "./button"

export default function Page({ items }: { items: { id: string; label: string }[] }) {
  const [n, setN] = useState(0)
  const [q, setQ] = useState("")
  return (
    <main>
      <p data-testid="count">{n}</p>
      <Button data-testid="inc" onClick={() => setN(n + 1)}>
        Add
      </Button>
      <Button data-testid="dec" variant="outline" size="sm" onClick={() => setN(n - 1)}>
        Remove
      </Button>
      <Input data-testid="q" placeholder="Search" onChange={(e) => setQ(e.target.value)} />
      <p data-testid="echo">{q}</p>
      <ul>
        {items.map((it) => (
          <li key={it.id} data-testid={`pick-${it.id}`}>
            <Button variant="ghost" onClick={() => setQ(it.label)}>
              {it.label}
            </Button>
          </li>
        ))}
      </ul>
    </main>
  )
}
