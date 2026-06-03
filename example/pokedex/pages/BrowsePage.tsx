// STUB (slice 1) — native page. Single return, no local bindings. The dex grid
// lands in a later slice.
export default function BrowsePage({ heading }: { heading: string }) {
  return (
    <section className="py-8">
      <h1 className="text-2xl font-extrabold tracking-tight text-slate-900 dark:text-white">
        {heading}
      </h1>
      <p className="mt-2 text-slate-500 dark:text-slate-400">Grid coming soon.</p>
    </section>
  )
}
