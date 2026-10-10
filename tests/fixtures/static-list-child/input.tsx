import Badge from './Badge'
type Badge = { type: string; label: string; color: string }
type Row = { id: number; name: string; displayName: string; num: string; badges: Badge[] }
// The bench D page: a static child fed by loader-precomputed values inside a nested list of a page
// with no state. Nothing on the client can ever change `rows` (ledger F70).
export default function Dex(props: { rows: Row[]; summary: string }) {
  return (
    <section>
      <p>{props.summary}</p>
      <table><tbody>
        {props.rows.map((p) => (
          <tr key={p.id}><td>{p.num}</td><td>{p.displayName}</td><td>{p.badges.map((b) => <Badge key={b.type} type={b.type} label={b.label} color={b.color} />)}</td></tr>
        ))}
      </tbody></table>
    </section>
  )
}
