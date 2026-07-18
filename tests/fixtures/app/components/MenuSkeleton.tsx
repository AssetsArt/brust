import Counter from './Counter'

export default function MenuSkeleton({
  label,
  count,
}: {
  label: string
  count: { start: number }
}) {
  return (
    <div className="menu-skeleton">
      <span>{label}</span>
      <Island component={Counter} props={count} hydrate="idle" />
    </div>
  )
}
