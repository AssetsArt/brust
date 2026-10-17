import Chip from './Chip'

// F369a negative (Afrojack r1): a second consumer of the rest beside the polymorphic child
export default function CarrierEm({ ...rest }: any) {
  return (
    <div>
      <Chip {...rest} />
      <em {...rest} />
    </div>
  )
}
