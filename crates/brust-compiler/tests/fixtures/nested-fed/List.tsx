// Repeats its children in a list: slot content is printed once and pasted per row.
export default function List({ items, children }: any) {
  return <ul>{items.map((i: string) => <li key={i}>{i}{children}</li>)}</ul>
}
