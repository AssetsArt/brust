import { createContext, useContext, useState } from 'react'
// F238: two native Providers, the inner one called inside the outer one's template around its {children}.
export const On = createContext(false)
export const K = createContext(0)
export function Frame({ id, children }: { id: string; children?: React.ReactNode }) {
  const [k, setK] = useState(1)
  return (
    <K.Provider value={k}>
      <section data-testid={`f${id}`} data-k={k} onClick={() => setK(k + 1)}>
        {children}
      </section>
    </K.Provider>
  )
}
export function Prov({ id, children }: { id: string; children?: React.ReactNode }) {
  const [on, setOn] = useState(false)
  return (
    <On.Provider value={on}>
      <button type="button" data-testid={`t${id}`} onClick={() => setOn(!on)}>t</button>
      <Frame id={id}>{children}</Frame>
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
// F374: a wrapper that only hands its props (children included) on to the native Provider.
export function Outer(props: { id: string; children?: React.ReactNode }) {
  return <Prov {...props} />
}
// F372: a native K Provider the content writes itself (inside Prov's content): nearer than Frame inside Prov.
export function KP({ id, v, children }: { id: string; v: number; children?: React.ReactNode }) {
  const [n, setN] = useState(v)
  return (
    <K.Provider value={n}>
      <span data-testid={`kp${id}`} data-kp={n} onClick={() => setN(n + 1)}>
        {children}
      </span>
    </K.Provider>
  )
}
// F372 R1: Frame BESIDE {children}: the content reads the call site's K (none here: the default 0), not Frame's.
export function Beside({ id, children }: { id: string; children?: React.ReactNode }) {
  const [on, setOn] = useState(false)
  return (
    <On.Provider value={on}>
      <button type="button" data-testid={`t${id}`} onClick={() => setOn(!on)}>t</button>
      <Frame id={id}>
        <b>inner</b>
      </Frame>
      {children}
    </On.Provider>
  )
}
