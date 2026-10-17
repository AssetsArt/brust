import Chip from './Chip'

// F369a: hands its whole rest, and with it `asChild`, to the one polymorphic child (Radix `RovingFocusGroup.Item`)
export default function Carrier({ tone = 'a', ...rest }: any) {
  return <Chip data-tone={tone} {...rest} />
}
