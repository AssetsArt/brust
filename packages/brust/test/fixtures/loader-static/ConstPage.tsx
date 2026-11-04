import { Amount, type Row } from './parts'

// F503: a constant-input instance (evaluated at build, F149) under a branch the page never takes here.
export default function ConstPage({ rows }: { rows: Row[] }) {
  return <main>{rows.length === 0 && <Amount price={undefined as unknown as number} />}<p>{rows.length}</p></main>
}
