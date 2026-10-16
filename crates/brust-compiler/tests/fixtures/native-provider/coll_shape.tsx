import { useState } from 'react'
import { createCollection } from '@radix-ui/react-collection'

const [Collection, useCollection, createCollectionScope] = createCollection<HTMLElement, { id: string }>('List')
void createCollectionScope
void useCollection

// two children of a Slot, a component child of an ItemSlot, and a prop on a Provider: none is the library's shape
function A() {
  const [n] = useState(0)
  return (
    <Collection.Provider scope={undefined} extra="x">
      <Collection.Slot scope={undefined}>
        <i>{n}</i>
        <b>{n}</b>
      </Collection.Slot>
    </Collection.Provider>
  )
}
function Inner() {
  return <li>x</li>
}
function B() {
  const [n] = useState(0)
  return (
    <Collection.ItemSlot scope={undefined} id={String(n)}>
      <Inner />
    </Collection.ItemSlot>
  )
}
export default function P() {
  return (
    <main>
      <A />
      <B />
    </main>
  )
}
