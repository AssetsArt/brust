import Search from './Search'

// A static wrapper: inlined with no host of its own.
export default function Plain() {
  return (
    <aside>
      <Search label="plain" />
    </aside>
  )
}
