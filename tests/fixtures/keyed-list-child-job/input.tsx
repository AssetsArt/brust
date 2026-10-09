import PriceRow from './PriceRow'
export default function Prices(props: { items: { id: string; price: number }[]; unit: string }) {
  return (
    <ul>
      {props.items.map((it) => (
        <PriceRow key={it.id} item={it} unit={props.unit} />
      ))}
    </ul>
  )
}
