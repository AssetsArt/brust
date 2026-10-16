import { useState } from 'react'
import { createCollection } from '@radix-ui/react-collection'

const [Collection, useCollection, createCollectionScope] = createCollection<HTMLElement, { id: string }>('List')
void createCollectionScope
void useCollection

// a scope that is not the component's own pass-through names another collection: refused
function Item({ id }: { id: string }) {
  const [n] = useState(0)
  return (
    <Collection.ItemSlot scope={'other'} id={id}>
      <li>{n}</li>
    </Collection.ItemSlot>
  )
}
export default function P() {
  return <Item id="a" />
}
