import * as React from 'react'

// F328c: a NATIVE wrapper (state + handler) around a child with a job of its own (a method chain the template cannot print),
// fed by the page's prop. The caller feeds the child's record through the wrapper (#229 hole closed by the re-base).
function Cell({ tone }: { tone: string }) {
  const label = tone.trim().toUpperCase().padEnd(6, '.')
  return <i data-label={label}>{label}</i>
}

function Wrap({ tone }: { tone: string }) {
  const [n, setN] = React.useState(0)
  return (
    <div>
      <button type="button" onClick={() => setN(n + 1)}>
        {n}
      </button>
      <Cell tone={tone} />
    </div>
  )
}

export default function WrapPage({ tone }: { tone: string }) {
  return (
    <main>
      <Wrap tone={tone} />
      <Wrap tone="fixed" />
    </main>
  )
}
