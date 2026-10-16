import { createContext, useContext } from 'react'

// a context with a literal default whose Provider hands out FIELDS but a consumer reads the WHOLE value (`v`): not the same
// frame shape, so the consumer cannot be given a value (fail closed)
const C = createContext<any>(undefined)
function P({ children }: { children?: React.ReactNode }) {
  return <C.Provider value={{ on: true }}>{children}</C.Provider>
}
function Whole() {
  const v = useContext(C)
  return <i data-v={v ? 'y' : 'n'}>x</i>
}
export default function Page() {
  return (
    <P>
      <Whole />
    </P>
  )
}
