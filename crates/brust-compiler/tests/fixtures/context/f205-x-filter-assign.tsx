type Row = { label: string }
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
export default function Page({ rows, fmt }: { rows: Row[]; fmt: any }) {
  return <Wrap>{rows.filter((r) => ((r.label = fmt), true)).map((r, k) => <p key={k}>{r.label.toUpperCase()}</p>)}</Wrap>
}
