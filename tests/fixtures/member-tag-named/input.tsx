import { Dialog as DialogPrimitive } from 'radix-ui'
import * as ResizablePrimitive from 'react-resizable-panels'
import Primitive from 'cmdk'

export default function Menu() {
  return (
    <nav>
      <DialogPrimitive.Root data-slot="dialog" />
      <DialogPrimitive.Trigger />
      <DialogPrimitive.Root />
      <ResizablePrimitive.Group />
      <Primitive.Item />
    </nav>
  )
}
