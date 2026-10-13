// A landing section's heading row: the h2 on the left, one lede paragraph on the right (stacked under 980 px).
export default function SecHead({ title, lede }: { title: string; lede: string }) {
  return (
    <div className="mb-9 grid grid-cols-2 items-end gap-8 max-wide:grid-cols-1">
      <h2>{title}</h2>
      <p className="max-w-[34rem] text-[1.05rem] text-ink-2">{lede}</p>
    </div>
  )
}
