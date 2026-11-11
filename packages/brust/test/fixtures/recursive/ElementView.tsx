export type El = { id: string; kind: 'group' | 'image' | 'text'; text?: string; src?: string; children?: El[] }

// F528: an element renders itself (a group arm maps its children back to ElementView).
export function ElementView({ n }: { n: El }) {
  switch (n.kind) {
    case 'group':
      return (
        <div data-id={n.id} className="group">
          {(n.children ?? []).map((c) => (
            <ElementView key={c.id} n={c} />
          ))}
        </div>
      )
    case 'image':
      return <img data-id={n.id} src={n.src} alt="" />
    default:
      return <p data-id={n.id}>{n.text}</p>
  }
}
