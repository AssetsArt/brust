// STUB (slice 1) — native page. Single return, no local bindings. Renders the
// AddToTeamButton native directive (its x-props JSON comes from the loader) so
// the directive bundle resolves; the full detail layout lands in a later slice.
import AddToTeamButton from '../components/AddToTeamButton'

export default function DetailPage({
  displayName,
  addProps,
}: {
  displayName: string
  addProps: string
}) {
  return (
    <section className="py-8">
      <h1 className="text-2xl font-extrabold tracking-tight text-slate-900 dark:text-white">
        {displayName}
      </h1>
      <p className="mt-2 text-slate-500 dark:text-slate-400">Detail coming soon.</p>
      <div className="mt-6 max-w-xs">
        <AddToTeamButton native data={addProps} />
      </div>
    </section>
  )
}
