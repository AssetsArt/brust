import * as React from 'react'

function useBoth(start: number) {
  return React.useState(start)
}

export default function SeedPage() {
  const [n, setN] = useBoth(1)
  return (
    <main>
      <button type="button" data-testid="seed" onClick={() => setN(n + 1)}>
        {n}
      </button>
    </main>
  )
}
