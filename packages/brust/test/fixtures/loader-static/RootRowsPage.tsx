import { Amount, type Row } from './parts'

// F142 at the root: the page's own per-row record, under a branch.
export default function RootRowsPage({ rows }: { rows: Row[] }) {
  return <main>{rows.map((s) => (s.type === 'price' ? <Amount key={s.id} price={s.data.price!} /> : <p key={s.id}>{s.data.title}</p>))}</main>
}
