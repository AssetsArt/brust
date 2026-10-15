import { useState } from 'react'
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
export default function Page({ s0 }: { s0: string }) {
  const [s, set] = useState(s0 || 'x')
  return <Wrap><button onClick={() => set('x')}>{s.toUpperCase()}</button></Wrap>
}
