import Chip from './Chip'

// F369a negative (a): the polymorphic child is conditional
export default function CarrierIf({ on, ...rest }: any) {
  return on ? <Chip {...rest} /> : <p>off</p>
}
