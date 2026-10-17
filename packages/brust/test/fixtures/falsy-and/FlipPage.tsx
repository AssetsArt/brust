import { useState } from 'react'

// F388: `left && <X/>` renders a falsy NUMBER left as text (0, NaN), and nothing for false/null/undefined/''.
export default function FlipPage() {
  const [n, setN] = useState(1)
  const [items, setItems] = useState<string[]>(['a'])
  const [s, setS] = useState('x')
  const [o, setO] = useState<{ k: number } | null>({ k: 1 })
  return (
    <main>
      <p data-testid="num">{n && <b>yes</b>}</p>
      <div data-testid="len">{items.length && <ul><li>list</li></ul>}</div>
      <p data-testid="text">count: {n && <i>on</i>} end</p>
      <p data-testid="str">{s && <u>s</u>}</p>
      <p data-testid="obj">{o && <em>o</em>}</p>
      <button type="button" data-testid="n0" onClick={() => setN(0)}>0</button>
      <button type="button" data-testid="n1" onClick={() => setN(1)}>1</button>
      <button type="button" data-testid="nan" onClick={() => setN(NaN)}>nan</button>
      <button type="button" data-testid="clear" onClick={() => setItems([])}>clear</button>
      <button type="button" data-testid="fill" onClick={() => setItems(['a'])}>fill</button>
      <button type="button" data-testid="s0" onClick={() => setS('')}>s0</button>
      <button type="button" data-testid="o0" onClick={() => setO(null)}>o0</button>
    </main>
  )
}
