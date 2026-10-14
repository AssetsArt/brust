import { Slot } from 'radix-ui'

export default function Btn({ asChild = false, variant = 'default', className, ...props }: any) {
  const Comp = asChild ? Slot.Root : 'button'
  return <Comp data-slot="btn" data-variant={variant} className={'base ' + (className ?? '')} {...props} />
}
