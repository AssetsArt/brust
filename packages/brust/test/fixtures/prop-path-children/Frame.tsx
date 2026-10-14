import { Body, Disclosure, Trigger } from './ui'

// A static wrapper (no state, no handler) around a React island. What the island's children read from the wrapper's
// props are holes (R34.116-R34.121): `label`, `note` and `shown` are primitives, `children` is the caller's tree.
export default function Frame({ label, note, shown, children }: { label: string; note?: string; shown?: boolean; children?: React.ReactNode }) {
  return (
    <section className="frame">
      <Disclosure label={label}>
        <Trigger>Toggle {label}</Trigger>
        <Body>
          <p data-testid="note" data-note={note}>
            {note}
          </p>
          {shown && <em data-testid="shown">shown</em>}
          {children}
        </Body>
      </Disclosure>
    </section>
  )
}
