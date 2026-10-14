import { Slot } from './mine'

export default function Own({ asChild, ...props }: any) {
  const Comp = asChild ? Slot.Root : 'span'
  return <Comp {...props} />
}
