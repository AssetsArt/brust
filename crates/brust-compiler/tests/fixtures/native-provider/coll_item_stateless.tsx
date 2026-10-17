import * as React from 'react'
import { useState } from 'react'
import { createCollection } from '@radix-ui/react-collection'

type ItemData = { id: string; focusable: boolean }
const [Collection, useCollection, createCollectionScope] = createCollection<HTMLElement, ItemData>('List')
void createCollectionScope

// the library's shape in one file: a Provider and a Slot around the list, an item slot around each item, and a component
// under the Provider that asks for the items
function ListImpl({ children }: { children?: React.ReactNode }) {
  const getItems = useCollection(undefined)
  const [n, setN] = useState(0)
  return (
    <ul
      data-n={n}
      onKeyDown={(e) => {
        const items = getItems().filter((i) => i.focusable)
        const at = items.findIndex((i) => i.ref.current === document.activeElement)
        const next = items[(at + 1) % items.length]
        if (next) (next.ref.current as HTMLElement).focus()
        setN(items.length)
        e.preventDefault()
      }}
    >
      {children}
    </ul>
  )
}

function List({ children }: { children?: React.ReactNode }) {
  return (
    <Collection.Provider scope={undefined}>
      <Collection.Slot scope={undefined}>
        <ListImpl>{children}</ListImpl>
      </Collection.Slot>
    </Collection.Provider>
  )
}

// F328b negative: the Item holds no state or handler of its own (no chunk to hold the item's data member): falls back.
function Row({ label, ...rest }: { label: string }) {
  return (
    <li tabIndex={0} {...rest}>
      {label}
    </li>
  )
}

function Item({ id, label }: { id: string; label: string }) {
  return (
    <Collection.ItemSlot scope={undefined} id={id} focusable>
      <Row label={label} />
    </Collection.ItemSlot>
  )
}

export default function Page() {
  return (
    <List>
      <Item id="a" label="A" />
    </List>
  )
}
