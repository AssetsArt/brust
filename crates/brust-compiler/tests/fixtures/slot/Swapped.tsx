import { Slot } from '@radix-ui/react-slot'

export default function Swapped({ plain, ...props }: any) {
  const Comp = plain ? 'p' : Slot
  return <Comp data-slot="swapped" {...props} />
}
