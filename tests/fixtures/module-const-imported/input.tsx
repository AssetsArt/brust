import LIMIT from './data'
import { ROWS, TITLE } from './data'

export default function Page() {
  return (
    <section title={TITLE}>
      <ul>
        {ROWS.map((r) => (
          <li key={r.id}>{r.name}</li>
        ))}
      </ul>
      <p>limit {LIMIT}</p>
    </section>
  )
}
