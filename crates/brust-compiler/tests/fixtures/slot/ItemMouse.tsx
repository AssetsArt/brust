import { useState } from 'react'
import { Slot } from 'radix-ui'

// F369c/F369b: like ItemLike, but its handler is a mousedown (Pressable binds click itself, so the two never share an event).
export default function ItemMouse({ asChild, children, ...rest }: any) {
  const [n, setN] = useState(0)
  const Comp = asChild ? Slot.Root : 'span'
  return (
    <Comp {...rest} data-n={n} onMouseDown={() => setN(n + 1)}>
      {children}
    </Comp>
  )
}
