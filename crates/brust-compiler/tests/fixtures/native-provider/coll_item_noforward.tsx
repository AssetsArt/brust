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

// F328b negative: the component under the ItemSlot does not spread its props, so React's Slot markers never reach an element (the
// item is not listed in React); brust must not print them either.
function Row({ label }: { label: string }) {
  return <li tabIndex={0}>{label}</li>
}

function Item({ id, label, disabled }: { id: string; label: string; disabled?: boolean }) {
  const [n] = useState(0)
  return (
    <Collection.ItemSlot scope={undefined} id={id} focusable={!disabled} data-n={n}>
      <Row label={label} />
    </Collection.ItemSlot>
  )
}

export default function Page() {
  return (
    <List>
      <Item id="a" label="A" />
      <Item id="b" label="B" disabled />
      <Item id="c" label="C" />
    </List>
  )
}
