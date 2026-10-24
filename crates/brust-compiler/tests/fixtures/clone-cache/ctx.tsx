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
// F374: wrappers that hand the children on to the native Provider without writing them as its children.
export function Outer(props: { children?: React.ReactNode }) {
  return <Prov {...props} />
}
export function OuterProp({ children }: { children?: React.ReactNode }) {
  return <Prov children={children} />
}
// F372: a native K Provider of the content's own (written at the call site, inside Prov's content).
export function KP({ v, children }: { v: number; children?: React.ReactNode }) {
  const [n, setN] = useState(v)
  return (
    <K.Provider value={n}>
      <span data-kp={n} onClick={() => setN(n + 1)}>
        {children}
      </span>
    </K.Provider>
  )
}
// F372 R1: Frame sits BESIDE {children}, so the content does not read Frame's K (React: the call site's K, here the default).
export function Beside({ children }: { children?: React.ReactNode }) {
  const [on, setOn] = useState(false)
  return (
    <On.Provider value={on}>
      <button type="button" onClick={() => setOn(!on)}>t</button>
      <Frame>
        <b>inner</b>
      </Frame>
      {children}
    </On.Provider>
  )
}
