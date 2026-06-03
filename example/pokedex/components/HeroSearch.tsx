// NATIVE INTERACTIVE COMPONENT — the hero search box. Single-file native
// directive: a co-located `export const behavior` (client logic, react-free) +
// a JSX `default` export (the native template the compiler lowers to
// minijinja). The build bundles ONLY `behavior` into _directives.js, registered
// as "heroSearch" (camelCase filename); the JSX default is tree-shaken out.
//
// react-free: `signal` from brustjs/store (the window singleton on the client),
// `navigate` from brustjs/navigation (imperative SPA navigation). On submit the
// behavior pushes /pokedex with the typed query — dogfooding imperative
// navigate() + query-object serialization.
import { Search } from 'lucide-react'
import { navigate } from 'brustjs/navigation'
import { signal } from 'brustjs/store'

// behavior → registered as "heroSearch". Tracks the input value via x-on-input
// and navigates to the browse page with `?q=` on submit/click.
export const behavior = () => {
  const value = signal('')
  const onInput = (e: Event) => value.set((e.target as HTMLInputElement).value)
  const go = (e?: Event) => {
    e?.preventDefault()
    navigate('/pokedex', { query: { q: value() } })
  }
  return { value, onInput, go }
}

// default → jinja. The <form> submit and the button click both call `go`; the
// input feeds the `value` signal through `onInput`.
export default function HeroSearch() {
  return (
    <form
      x-data="heroSearch"
      x-on-submit="go"
      className="mx-auto mt-8 flex w-full max-w-md items-center gap-2 rounded-2xl bg-white/95 p-2 shadow-lg ring-1 ring-black/5 dark:bg-slate-900/90 dark:ring-white/10"
    >
      <input
        type="search"
        placeholder="Search the Pokédex…"
        x-on-input="onInput"
        className="min-w-0 flex-1 rounded-xl bg-transparent px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none dark:text-white"
      />
      <button
        type="submit"
        className="inline-flex items-center gap-1.5 rounded-xl bg-brand-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-600"
      >
        <Search size={16} isr={{ key: 'LcIconSearch' }} />
        Search
      </button>
    </form>
  )
}
