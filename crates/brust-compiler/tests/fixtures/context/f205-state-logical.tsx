import { useState } from 'react'
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
export default function Page({ n }: { n?: number }) {
  const [s, set] = useState((n ?? 0) > 1 && 'many' || 'one')
  return <Wrap><button onClick={() => set('x')}>{s.toUpperCase()}</button></Wrap>
}
