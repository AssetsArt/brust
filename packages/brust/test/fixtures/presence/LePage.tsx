import * as React from 'react'

// Mellow F1 (ruling 94404307 amended): a layout effect writes a ref, a passive effect of the same commit reads it. React
// runs the layout effect first on every re-render, so the passive effect sees the value of this render.
export default function LePage() {
  const [n, setN] = React.useState(0)
  const [seen, setSeen] = React.useState('none')
  const latest = React.useRef('init')
  React.useLayoutEffect(() => {
    latest.current = `v${n}`
  }, [n])
  React.useEffect(() => {
    setSeen(latest.current)
  }, [n])
  return (
    <main>
      <button type="button" data-testid="inc" onClick={() => setN(n + 1)}>inc</button>
      <p data-testid="n">{n}</p>
      <p data-testid="seen">{seen}</p>
    </main>
  )
}
