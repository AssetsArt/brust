function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
const O = { s: 'a', toString() { (this as any).s = { toUpperCase: () => 'x' }; return '' } }
const T = O.toString()
export default function Page() {
  return <Wrap>{O.s.toUpperCase()}</Wrap>
}
