import { TernaryList, type Row } from './parts'

export default function TernaryRowsPage({ rows }: { rows: Row[] }) {
  return <main><TernaryList rows={rows} /></main>
}
