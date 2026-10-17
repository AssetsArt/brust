import Chip from './Chip'

// F369a negative (a): two polymorphic children
export default function CarrierTwo(props: any) {
  return (
    <div>
      <Chip {...props} />
      <Chip {...props} />
    </div>
  )
}
