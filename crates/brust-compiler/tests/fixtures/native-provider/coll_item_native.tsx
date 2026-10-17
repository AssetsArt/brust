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

// F328b negative: the component under the ItemSlot is NATIVE (it has its own scope and host): the item directive would read its data
// in the child's scope, not the Item's, so the call site falls back.
function Row({ label, ...rest }: { label: string }) {
  const [on, setOn] = useState(false)
  return (
    <li tabIndex={0} {...rest} data-on={on} onClick={() => setOn(!on)}>
      {label}
    </li>
  )
}

function Item({ id, label }: { id: string; label: string }) {
  const [n] = useState(0)
  return (
    <Collection.ItemSlot scope={undefined} id={id} focusable data-n={n}>
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
