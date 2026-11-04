import { AndList, type Row } from './parts'

export default function AndRowsPage({ rows }: { rows: Row[] }) {
  return <main><AndList rows={rows} /></main>
}
