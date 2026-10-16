// F257, the same shape through an object spread (the B5 spelling, context-lowering-3 and later).
import { useState } from 'react'
export default function B(props: any) {
  const [n, setN] = useState(0)
  const style = { ...props.style, color: 'red', zIndex: Math.max(1, 2) }
  return <div data-testid="d" style={style} onClick={() => setN(n + 1)}>{n}</div>
}
