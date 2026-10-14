import * as Slot from '@radix-ui/react-slot'

export default function Chip({ asChild, ...props }: any) {
  const Comp = asChild ? Slot.Root : 'span'
  return <Comp data-slot="chip" {...props} />
}
