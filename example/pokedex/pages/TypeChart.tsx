// STUB (slice 1) — native page. Single return, no local bindings. The 18×18
// effectiveness matrix lands in a later slice.
export default function TypeChart({ heading }: { heading: string }) {
  return (
    <section className="py-8">
      <h1 className="text-2xl font-extrabold tracking-tight text-slate-900 dark:text-white">
        {heading}
      </h1>
      <p className="mt-2 text-slate-500 dark:text-slate-400">Matrix coming soon.</p>
    </section>
  )
}
