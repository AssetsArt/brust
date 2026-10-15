type Row = { label: string }
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
export default function Page({ rows, fmt }: { rows: Row[]; fmt: () => string }) {
  return <Wrap>{rows.filter((r) => Object.assign(r, { label: { toUpperCase: fmt } })).map((r, k) => <p key={k}>{r.label.toUpperCase()}</p>)}</Wrap>
}
