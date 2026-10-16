import { createContext, useContext, useEffect, useRef, useState } from 'react'

// F304: consumers that read the context in code printed as written: a handler calls a field, an effect reads another
const A = createContext<{ open: boolean; toggle: () => void }>({ open: false, toggle: () => {} })

function CtxP({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <A.Provider value={{ open, toggle: () => setOpen((o) => !o) }}>
      <section data-open={open ? 'y' : 'n'}>{children}</section>
    </A.Provider>
  )
}
function CtxBtn() {
  const c = useContext(A)
  return (
    <button
      onClick={() => {
        c.toggle()
      }}
    >
      t
    </button>
  )
}
function CtxSeen() {
  const c = useContext(A)
  const r = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (r.current) r.current.dataset.seen = c.open ? 'y' : 'n'
  }, [c.open])
  return <p ref={r}>s</p>
}
export default function CtxVPage() {
  return (
    <main>
      <CtxP>
        <CtxBtn />
        <CtxSeen />
      </CtxP>
    </main>
  )
}
