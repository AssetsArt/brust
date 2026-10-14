import { Slot } from 'radix-ui'

export default function Bag({ asChild, attrs, ...props }: any) {
  const Comp = asChild ? Slot.Root : 'div'
  return <Comp {...attrs} data-slot="bag" {...props} />
}
