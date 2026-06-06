// NATIVE INTERACTIVE COMPONENT — the Rendering page "island vs native" demo. A
// react-free switch: a boolean signal toggled by x-on-click, with x-show driving
// the knob position and a computed label. Ships as its own directive chunk.
import { computed, signal } from 'brustjs/store'

export const behavior = () => {
  const on = signal(true)
  const off = computed(() => !on())
  const label = computed(() => (on() ? 'Hydrated' : 'Static HTML'))
  const toggle = () => on.set(!on())
  return { on, off, label, toggle }
}

export const source =
  'import { computed, signal } from \'brustjs/store\'\n\nexport const behavior = () => {\n  const on = signal(true)\n  const off = computed(() => !on())\n  const label = computed(() => (on() ? \'Hydrated\' : \'Static HTML\'))\n  const toggle = () => on.set(!on())\n  return { on, off, label, toggle }\n}\n\n// <button x-on-click="toggle">\n//   <span x-show="on" /> <span x-show="off" />\n//   <span x-text="label">Hydrated</span>\n// </button>'

export default function Toggle() {
  return (
    <button
      type="button"
      x-on-click="toggle"
      aria-label="Toggle hydration"
      className="inline-flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900"
    >
      <span className="relative inline-block h-6 w-11 rounded-full bg-slate-300 dark:bg-slate-700">
        <span
          x-show="on"
          className="absolute top-0.5 right-0.5 h-5 w-5 rounded-full bg-brand-500 shadow"
        />
        <span
          x-show="off"
          className="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow"
        />
      </span>
      <span x-text="label" className="text-sm font-medium text-slate-900 dark:text-slate-100">
        Hydrated
      </span>
    </button>
  )
}
