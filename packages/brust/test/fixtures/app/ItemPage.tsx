// useId, precompute via helper, keyed list with a child that has its own job, react child.
import { useId } from 'react'
import { fmt } from './money'
import PriceRow from './PriceRow'
import Team from './Team'

export default function ItemPage(props: {
  item: { id: string; name: string; price: number; rows: { id: string; price: number }[] }
  unit: string
  team: string[]
}) {
  const id = useId()
  return (
    <article>
      <h1 id={id}>{props.item.name}</h1>
      <p className="total">{fmt(props.item.price, props.unit)}</p>
      <ul>
        {props.item.rows.map((r) => (
          <PriceRow key={r.id} item={r} unit={props.unit} />
        ))}
      </ul>
      <Team team={props.team} />
    </article>
  )
}
