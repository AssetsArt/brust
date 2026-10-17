import Chip from './Chip'

// F363a negative: it hands its props, and with them `asChild`, on to a polymorphic component: a requirement on the call
export default function Carry(props: any) {
  return (
    <div>
      <Chip {...props} />
    </div>
  )
}
