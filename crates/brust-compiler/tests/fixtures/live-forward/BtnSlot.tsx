import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'

// The shape brust gives Radix `Primitive.<tag>` (`primitive_child`): `asChild` is taken out of the props pattern and
// the rest is spread on `Comp`. With `asChild` a Slot merges the call site's `style` with its child element's own;
// the child never names `style` itself.
export default React.forwardRef(function BtnSlot({ asChild, ...primitiveProps }: any, forwardedRef: any) {
  const Comp = asChild ? Slot : 'button'
  return <Comp {...primitiveProps} ref={forwardedRef} />
})
