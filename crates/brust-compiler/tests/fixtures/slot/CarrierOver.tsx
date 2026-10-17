import Chip from './Chip'

// F369a negative (c): the flag is written on the child after the spread
export default function CarrierOver(props: any) {
  return <Chip {...props} asChild={false} />
}
