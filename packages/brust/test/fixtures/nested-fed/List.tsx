export default function List({ items, children }: any) { return <ul>{items.map((i: string) => <li key={i}>{i}{children}</li>)}</ul> }
