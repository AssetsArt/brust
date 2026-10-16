import { useState } from 'react'
import { createCollection } from '@radix-ui/react-collection'

const [Collection, useCollection, createCollectionScope] = createCollection<HTMLElement, { id: string }>('List')
void createCollectionScope

// the list exists only in the browser: asking for it while rendering has no server value
function Count() {
  const getItems = useCollection(undefined)
  const [n] = useState(0)
  return (
    <p>
      {n}:{getItems().length}
    </p>
  )
}
export default function P() {
  return (
    <Collection.Provider scope={undefined}>
      <Count />
    </Collection.Provider>
  )
}
