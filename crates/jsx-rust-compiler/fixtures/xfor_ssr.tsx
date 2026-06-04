export default function Grid({ items }: { items: { id: number; num: string; detailHref: string }[] }) {
  return (
    <div>
      <a x-for="c in items by c.id" x-bind-href="c.detailHref">
        <span x-text="c.num" />
      </a>
    </div>
  )
}
