// STUB (slice 1) — native page. Single return, no local bindings. Real landing
// content lands in a later slice.
export default function HomePage({ heading }: { heading: string }) {
  return (
    <section className="py-12 text-center">
      <h1 className="text-4xl font-extrabold tracking-tight text-slate-900 dark:text-white">
        {heading}
      </h1>
      <p className="mt-3 text-slate-500 dark:text-slate-400">
        A native-first brust example. Content coming soon.
      </p>
    </section>
  )
}
