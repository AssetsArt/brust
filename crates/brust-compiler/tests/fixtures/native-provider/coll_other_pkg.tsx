import { useState } from 'react'
import { createCollection } from 'some-other-package'

const [Collection, useCollection] = createCollection<HTMLElement, { id: string }>('List') as any
void useCollection

// the same export name from another package is not the recognised one
function Item() {
  const [n] = useState(0)
  return (
    <Collection.ItemSlot scope={undefined} id="a">
      <li>{n}</li>
    </Collection.ItemSlot>
  )
}
export default function P() {
  return <Item />
}
