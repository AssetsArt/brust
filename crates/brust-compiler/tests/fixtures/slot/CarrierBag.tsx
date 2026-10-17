import Bag from './Bag'

// F369a negative: the polymorphic element spreads keys known only at render of its own (Bag's `{...attrs}`)
export default function CarrierBag(props: any) {
  return <Bag {...props} />
}
