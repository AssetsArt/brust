import { GtList, type Row } from './parts'

export default function GtRowsPage({ rows }: { rows: Row[] }) {
  return <main><GtList rows={rows} /></main>
}
