// F205: receivers proven primitive: item fields of a module-const array (nested, filtered) and a filtered prop list.
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
const GROUPS = [{ name: 'g', items: [{ label: 'alpha', n: 1.25, on: true }, { label: 'beta', n: 2, on: false }] }]
export default function Page({ rows = [{ label: 'x', on: true }, { label: 'y', on: false }] }: { rows?: { label: string; on: boolean }[] }) {
  return (
    <Wrap>
      {GROUPS.map((g) => <div key={g.name}>{g.items.filter((i) => i.on === true).map((i) => <p key={i.label}>{i.label.toUpperCase()}|{i.n.toFixed(1)}</p>)}</div>)}
      {GROUPS[0].items.map((i) => <i key={i.label}>{i.label.padStart(7, '*')}</i>)}
      {rows.filter((r) => r.on).map((r) => <b key={r.label}>{r.label.toUpperCase()}</b>)}
    </Wrap>
  )
}
