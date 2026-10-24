import { useId } from './id'

// Radix's own useId (`./id.tsx`, a verbatim copy of @radix-ui/react-id's source; tests/server/radix-id.test.ts keeps it honest): a statement-level call, one with a deterministic id, and one
// hoisted out of an attribute. Each is an id slot with the `radix-` prefix, as React renders it.
export default function Field({ label, fixed }: { label: string; fixed?: string }) {
  const id = useId(fixed)
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} aria-describedby={useId()} />
    </div>
  )
}
