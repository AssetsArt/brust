import { createCollection } from '@radix-ui/react-collection'

const [Collection, useCollection, createCollectionScope] = createCollection<HTMLElement, { id: string }>('List')
void useCollection
void createCollectionScope

// the child of a Slot is a component with no state: its host is not a native instance, so no marker can land on it
function Plain({ children }: { children?: React.ReactNode }) {
  return <ul>{children}</ul>
}
function List() {
  return (
    <Collection.Provider scope={undefined}>
      <Collection.Slot scope={undefined}>
        <Plain>
          <li>a</li>
        </Plain>
      </Collection.Slot>
    </Collection.Provider>
  )
}
export default function P() {
  return <List />
}
