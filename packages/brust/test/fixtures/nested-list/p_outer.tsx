import { useState } from 'react'

// The inner list reads the outer item (its tag, its index) as well as its own.
const GROUPS = [
  { id: 'a', tag: 'A', items: ['one', 'two'] },
  { id: 'b', tag: 'B', items: ['three'] },
]
export default function POuter() {
  const [on, setOn] = useState('a')
  return (
    <main>
      <button type="button" data-testid="go" onClick={() => setOn('b')}>
        b
      </button>
      {GROUPS.map((g, gi) => (
        <section key={g.id} data-on={on === g.id ? 'yes' : 'no'}>
          {g.items.map((it, ii) => (
            <p key={it} data-testid={`${g.id}${ii}`}>{`${g.tag}${gi}.${ii}:${it}:${on}`}</p>
          ))}
        </section>
      ))}
    </main>
  )
}
