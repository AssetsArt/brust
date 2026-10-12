// dangerouslySetInnerHTML golden (inner-html lane): the loader picks the value, the page paints it raw.
export default function Raw({ h, t }: { h: unknown; t: string }) {
  return (
    <section>
      <div id="raw" dangerouslySetInnerHTML={{ __html: h as string }} />
      <p id="text">{t}</p>
    </section>
  )
}
