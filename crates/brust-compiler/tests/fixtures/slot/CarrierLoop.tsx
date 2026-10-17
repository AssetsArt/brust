import Chip from './Chip'

// F369a negative (a): the polymorphic child is in a list
export default function CarrierLoop({ items, ...rest }: any) {
  return <ul>{items.map((i: string) => <Chip key={i} {...rest} />)}</ul>
}
