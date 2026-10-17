import { useState } from 'react'
import { Indicator, Root } from './ProvV'
// A stateless wrapper passing its own prop to the Provider it specialises (shadcn's Progress over Radix's Root, F323).
export function Wrap({ value }: { value: number }) {
  return (
    <Root value={value}>
      <Indicator />
    </Root>
  )
}
// The same with an instance of its own: its props follow its caller (F320), so the clone follows them too.
export function LiveWrap({ value }: { value: number }) {
  const [n, setN] = useState(0)
  return (
    <section data-n={n} onClick={() => setN(n + 1)}>
      <Root value={value}>
        <Indicator />
      </Root>
    </section>
  )
}
// shadcn's Progress exactly: the props reach the Provider only through the wrapper's own rest.
export function RestWrap({ ...props }: { value: number; max?: number }) {
  return (
    <Root {...props}>
      <Indicator />
    </Root>
  )
}
