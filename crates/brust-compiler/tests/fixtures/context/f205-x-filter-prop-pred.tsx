type Row = { label: string }
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
export default function Page({ rows, pred }: { rows: Row[]; pred: (r: Row) => boolean }) {
  return <Wrap>{rows.filter(pred).map((r, k) => <p key={k}>{r.label.toUpperCase()}</p>)}</Wrap>
}
