type Row = { label: string; on: boolean }
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
export default function Page({ rows }: { rows: Row[] }) {
  return <Wrap>{rows.filter((r) => r.on).map((r) => <p key={r.label}>{r.label.toUpperCase()}</p>)}</Wrap>
}
