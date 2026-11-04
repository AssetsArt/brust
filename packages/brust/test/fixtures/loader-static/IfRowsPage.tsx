import { IfList, type Row } from './parts'

export default function IfRowsPage({ rows }: { rows: Row[] }) {
  return <main><IfList rows={rows} /></main>
}
