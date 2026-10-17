import { useState } from 'react'
// not a Provider: a function prop called in render with a local object holding a setter is not spliced anywhere
function Show({ fmt }: { fmt: (c: { on: boolean; setOn: (v: boolean) => void }) => string }) {
  const [on, setOn] = useState(false)
  const ctx = { on, setOn }
  return <p onClick={() => setOn(!on)}>{fmt(ctx)}</p>
}
export default function P() { return <main><Show fmt={(c) => (c.on ? 'y' : 'n')} /></main> }
