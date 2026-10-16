import { useState } from 'react'
import { createCollection } from '@radix-ui/react-collection'

const [Collection, useCollection, createCollectionScope] = createCollection<HTMLElement, { id: string }>('List')
void useCollection
void createCollectionScope

// `element` is the feature's own key of an item: data may not claim it
function Item({ id }: { id: string }) {
  const [n] = useState(0)
  return (
    <Collection.ItemSlot scope={undefined} id={id} element={n}>
      <li>{n}</li>
    </Collection.ItemSlot>
  )
}
export default function P() {
  return <Item id="a" />
}
