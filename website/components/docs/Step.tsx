// A numbered step heading (canon: the amber circle before the title); `id` is the anchor the TOC links to.
export default function Step({ n, id, title }: { n: number; id: string; title: string }) {
  return (
    <h2 id={id}>
      <span className="n">{n}</span>
      {title}
    </h2>
  )
}
