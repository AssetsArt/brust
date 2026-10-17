import { Slot } from 'radix-ui'

// F363a negative: the element `asChild` replaces carries `dangerouslySetInnerHTML`
export default function Dsi({ asChild, ...props }: any) {
  const Comp = asChild ? Slot.Root : 'div'
  return <Comp dangerouslySetInnerHTML={{ __html: 'x' }} {...props} />
}
