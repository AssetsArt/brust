import { SwitchList, type Row } from './parts'

export default function SwitchRowsPage({ rows }: { rows: Row[] }) {
  return <main><SwitchList rows={rows} /></main>
}
