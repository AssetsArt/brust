import { useState } from 'react'
import { Slot } from 'radix-ui'

// F369b step A: a NATIVE polymorphic parent (state of its own, a handler on its polymorphic element) given `asChild`
// over a host element: the call site asks for a host clone with the child as the content of `{children}`.
export default function ItemLike({ asChild, children, ...rest }: any) {
  const [n, setN] = useState(0)
  const Comp = asChild ? Slot.Root : 'span'
  return (
    <Comp {...rest} data-n={n} onClick={() => setN(n + 1)}>
      {children}
    </Comp>
  )
}
