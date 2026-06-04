export default function Grid2({ data }: { data?: string }) {
  return (
    <section x-data="f" x-props={data}>
      <a x-for="c in filtered by c.id" x-bind-href="c.detailHref">
        <span x-text="c.num" />
      </a>
    </section>
  )
}
