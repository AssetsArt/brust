import { Badge, Tip } from './ui'

const on = true
const items = [
  { name: 'Home', url: '/' },
  { name: 'Inbox', url: '/inbox' },
]
const tags = Array.from({ length: 4 }).map((_, i, a) => `v1.0.${a.length - i}`)
const hostile = ['"q" \'a\' </script><b>x</b> & done', 'plain']

// No state on the page: it stays static. Each <Tip> is an island that gets its lists, its condition and its element
// prop folded by the compiler and revived by React.
export default function Page() {
  return (
    <main>
      <h1>island slots</h1>
      <Tip label="one" content={<Badge text="hint" tone="loud" />}>
        <ul>
          {items.map((item, i) => (
            <li key={item.name}>
              <a href={item.url}>
                {i}: {item.name}
              </a>
            </li>
          ))}
        </ul>
        {on && <u>shown</u>}
        {!on && <u>hidden</u>}
      </Tip>
      <Tip
        label="two"
        content={
          <>
            <b>a</b>
            <Badge text="frag" />
          </>
        }
      >
        {tags.map((tag) => (
          <p key={tag}>{tag}</p>
        ))}
        {hostile.map((s) => (
          <p key={s} data-hostile="1">
            {s}
          </p>
        ))}
      </Tip>
    </main>
  )
}
