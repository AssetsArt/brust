import { useState } from 'react'
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
export default function Page({ on }: { on?: boolean }) {
  const [s, set] = useState(on ? 'open' : 'shut')
  return <Wrap><button onClick={() => set('x')}>{s.toUpperCase()}</button></Wrap>
}
