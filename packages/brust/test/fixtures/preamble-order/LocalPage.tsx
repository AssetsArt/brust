import { useState } from 'react'

function useLocal(n: number) {
  const [x] = useState(n)
  return 'L' + x
}

export default function LocalPage() {
  const label = useLocal(1)
  return (
    <main>
      <p data-testid="local" title={label}>
        local
      </p>
    </main>
  )
}
