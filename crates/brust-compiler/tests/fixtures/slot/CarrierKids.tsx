import Chip from './Chip'

// F369a negative (Afrojack r1): the polymorphic child has children of its own, so React clones THAT element
export default function CarrierKids({ ...rest }: any) {
  return (
    <Chip {...rest}>
      <i>{rest.children}</i>
    </Chip>
  )
}
