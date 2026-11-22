import { Dynamic } from '@brust/core'
import { List } from './List'

type Item = { id: string }
const NO_SIDE = { on: false }

// `side` is omitted by the page: the module default decides which branch renders.
export default function ParentOff({ items, side = NO_SIDE }: { items: Item[]; side?: { on: boolean } }) {
  return (
    <main>
      {side.on ? (
        <div className="side">
          <List items={items} />
        </div>
      ) : (
        <div className="plain">
          <List items={items} />
        </div>
      )}
      <Dynamic component="hello" props={{ label: 'slot' }} />
    </main>
  )
}
