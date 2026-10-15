import { useState } from 'react'

function Box({ children }: { children?: React.ReactNode }) {
  const [n, setN] = useState(0)
  return <div onClick={() => setN(n + 1)} data-n={n}>{children}</div>
}

export default function Page() {
  const [items, setItems] = useState(['a'])
  return (
    <section>
      <button onClick={() => setItems([...items, 'b'])}>add</button>
      <Box>
        <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>
      </Box>
    </section>
  )
}
