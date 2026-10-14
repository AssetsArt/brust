import { useState } from 'react'
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page({ fmt, obj }: { fmt?: () => string; obj?: { toString(): string } }) {
  void obj
  void fmt
  const [n, set] = useState(1234.5)
  return <Wrap><button onClick={() => set(n + 1)}>{n.toFixed(2)}</button></Wrap>
}
