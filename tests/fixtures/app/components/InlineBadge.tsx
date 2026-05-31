export default function InlineBadge({ label, strong }: { label: string; strong: boolean }) {
  return (
    <span class="ibadge">{strong ? <b>{label}</b> : <i>{label}</i>}</span>
  )
}
