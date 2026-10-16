import Box from './Box'
// Passes its children on to a native child: two host levels between the page and its content.
export default function Outer({ children }: { children?: React.ReactNode }) {
  return <section><Box>{children}</Box></section>
}
