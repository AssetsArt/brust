import PriceRow from './PriceRow'

export default function Grid(props: { groups: { id: string; rows: { id: string; price: number }[] }[]; unit: string }) {
  return (
    <div>
      {props.groups.map((g) => (
        <ul key={g.id}>
          {g.rows.map((r) => (
            <PriceRow key={r.id} item={r} unit={props.unit} />
          ))}
        </ul>
      ))}
    </div>
  )
}
