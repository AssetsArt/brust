import Chip from './Chip'

// F369a: reading the flag itself (`rest.asChild`) inside a carrier is allowed on purpose; it still reaches the child
export default function CarrierFlagRead({ ...rest }: any) {
  return <Chip data-flag={String(rest.asChild)} {...rest} />
}
