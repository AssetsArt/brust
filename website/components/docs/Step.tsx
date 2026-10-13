// A numbered step heading (canon: the amber circle before the title); `id` is the anchor the TOC links to.
export default function Step({ n, id, title }: { n: number; id: string; title: string }) {
  return (
    <h2 id={id}>
      <span className="inline-grid h-8 w-8 flex-none place-items-center rounded-full bg-amber-fill font-mono text-[13px] font-normal text-on-amber">{n}</span>
      {title}
    </h2>
  )
}
