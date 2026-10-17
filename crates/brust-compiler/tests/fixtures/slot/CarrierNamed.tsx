import Chip from './Chip'

// F369a negative (b): the carrier reads the flag itself, so the rest does not carry it
export default function CarrierNamed({ asChild, ...rest }: any) {
  return <Chip data-mine={String(asChild)} {...rest} />
}
