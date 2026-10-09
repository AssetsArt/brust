// The keyed-list-child-job shape: own precompute job ⇒ per-row instance.
import { fmt } from './money'

export default function PriceRow(props: { item: { id: string; price: number }; unit: string }) {
  return <li>{fmt(props.item.price, props.unit)}</li>
}
