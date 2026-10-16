import { createContext, useContext } from 'react'

// the reverse: the Provider hands out ONE value (a prop) and a consumer reads a field of it
const C = createContext<any>(undefined)
function P({ m, children }: { m: any; children?: React.ReactNode }) {
  return <C.Provider value={m}>{children}</C.Provider>
}
function Field() {
  const c = useContext(C)
  return <i data-on={c.on}>x</i>
}
export default function Page() {
  return (
    <P m={{ on: true }}>
      <Field />
    </P>
  )
}
