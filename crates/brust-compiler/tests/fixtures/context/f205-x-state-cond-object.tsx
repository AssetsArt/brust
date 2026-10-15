import { useState } from 'react'
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
export default function Page({ on, fmt }: { on?: boolean; fmt?: () => string }) {
  const [s, set] = useState(on ? { toUpperCase: fmt } : 'shut')
  return <Wrap><button onClick={() => set('x')}>{s.toUpperCase()}</button></Wrap>
}
