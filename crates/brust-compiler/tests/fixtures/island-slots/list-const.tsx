import { Card } from './ui'

const items = [
  { title: 'Home', url: '/' },
  { title: 'Inbox', url: '/inbox' },
]

export default function Page() {
  return (
    <Card title="a">
      <ul>
        {items.map((item, i) => (
          <li key={item.title}>
            <a href={item.url}>
              {i}: {item.title}
            </a>
          </li>
        ))}
      </ul>
    </Card>
  )
}
