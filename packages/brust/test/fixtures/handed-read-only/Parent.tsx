import { Dynamic } from '@brust/core'
import { List } from './List'

type Item = { type: string; id: string }
const NO_SIDE = { on: false, at: 'right' }

// `side` is omitted by the page: it is the module default, and the job under `side.on` cannot be rebased onto the call.
export default function Parent({ items, side = NO_SIDE }: { items: Item[]; side?: { on: boolean; at: string } }) {
  return (
    <main>
      {side.on ? (
        <div data-at={side.at}>
          <List items={items} />
        </div>
      ) : (
        <List items={items} />
      )}
      <Dynamic component="slot.badge" props={{ label: 'x' }} />
    </main>
  )
}
