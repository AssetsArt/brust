import { createContext, useContext, useState } from 'react'

// a context field named like a template name (`loop`): the hidden prop is `__ctx_<ctx>_loop`, so nothing is shadowed
const M = createContext<{ loop: boolean; flip: () => void }>({ loop: false, flip: () => {} })

function LProvider({ children }: { children?: React.ReactNode }) {
  const [loop, setLoop] = useState(false)
  return <M.Provider value={{ loop, flip: () => setLoop((o) => !o) }}>{children}</M.Provider>
}
function LTrigger() {
  const c = useContext(M)
  return <button aria-pressed={c.loop} onClick={c.flip}>go</button>
}
export default function P() {
  return (
    <LProvider>
      <LTrigger />
    </LProvider>
  )
}
