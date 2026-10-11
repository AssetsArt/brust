// Route "/unified" — one store, three surfaces: a React island, a native counter and a native read-only node all
// read and write `unified`. First paint comes from the server snapshot (`?start=` seeds it in the loader).
import UnifiedIsland from '../components/UnifiedIsland'
import UnifiedNative from '../components/UnifiedNative'
import UnifiedStoreNode from '../components/UnifiedStoreNode'

export default function UnifiedPage() {
  return (
    <section className="py-2">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white">Unified store</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-500 dark:text-slate-400">
          One store, three surfaces. The server seeds it, the first paint already shows the value, and a click on either side
          moves the island, the native counter and the centre node together, with no reload.
        </p>
      </div>
      <div className="grid items-center gap-6 rounded-3xl border border-slate-200 bg-white p-8 shadow-sm md:grid-cols-3 dark:border-slate-800 dark:bg-slate-900">
        <UnifiedIsland />
        <UnifiedStoreNode />
        <UnifiedNative />
      </div>
    </section>
  )
}
