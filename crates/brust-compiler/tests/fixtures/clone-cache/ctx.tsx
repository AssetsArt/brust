import { createContext, useContext, useState } from 'react'
// F238: two native Providers, the inner one called inside the outer one's template around its {children}.
export const On = createContext(false)
export const K = createContext(0)
export function Frame({ children }: { children?: React.ReactNode }) {
  const [k, setK] = useState(1)
  return (
    <K.Provider value={k}>
      <section data-k={k} onClick={() => setK(k + 1)}>
        {children}
      </section>
    </K.Provider>
  )
}
export function Prov({ children }: { children?: React.ReactNode }) {
  const [on, setOn] = useState(false)
  return (
    <On.Provider value={on}>
      <button type="button" onClick={() => setOn(!on)}>t</button>
      <Frame>{children}</Frame>
    </On.Provider>
  )
}
export function Both({ label }: { label: string }) {
  const on = useContext(On)
  const k = useContext(K)
  return <i data-on={on ? 1 : 0} data-k={k}>{label}</i>
}
export function OnlyK({ label }: { label: string }) {
  const k = useContext(K)
  return <b data-k={k}>{label}</b>
}
export function OnlyOn({ label = 'o' }: { label?: string }) {
  const on = useContext(On)
  return <u data-on={on ? 1 : 0}>{label}</u>
}
