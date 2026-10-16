// F257 (Mellow, context-lowering-3 round 1 N1), the hand-written spelling: a body local named like a prop the precompute
// job reads off a plain `props` parameter. The job destructured the prop under its key next to the local's `const`
// (a SyntaxError: the job module failed to load, no diagnostic); it destructures it under another name now. `Math.max`
// keeps the job (since F277 a plain merge prints in the template).
import { useState } from 'react'
export default function D(props: any) {
  const [n, setN] = useState(0)
  const style = Object.assign({}, props.style, { color: 'red', zIndex: Math.max(1, 2) })
  return <div data-testid="d" style={style} onClick={() => setN(n + 1)}>{n}</div>
}
