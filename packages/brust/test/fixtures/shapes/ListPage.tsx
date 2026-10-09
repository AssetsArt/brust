import { cache } from '@brust/brust'
import Badge from './Badge'
import Clock from './Clock'

function ListPage(props: { page: { id: string }; items: { id: string; name: string }[] }) {
  return (
    <section>
      <ul>
        {props.items.map((it) => (
          <li key={it.id}>
            <Badge label={it.name} />
          </li>
        ))}
      </ul>
      <Clock />
    </section>
  )
}

export default cache(ListPage, { key: (p) => p.page.id, tags: () => ['list'], revalidate: 30 })
