import { useState } from 'react'
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page({ fmt, obj }: { fmt?: () => string; obj?: { toString(): string } }) {
  void obj
  void fmt
  const [o, set] = useState(() => ({ toString: fmt }))
  return <Wrap><button onClick={() => set(o)}>{o.toString()}</button></Wrap>
}
