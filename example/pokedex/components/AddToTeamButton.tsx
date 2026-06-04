// NATIVE INTERACTIVE COMPONENT (Spec B dogfood) — the "Add to team / In your
// team" toggle on the detail page. A single-file native directive component: a
// co-located `export const behavior` (client logic, react-free) + a JSX
// `default` export (the native template the compiler lowers to minijinja). The
// build bundles ONLY `behavior` into _directives.js; the JSX default is
// tree-shaken out so react never leaks into the client bundle.
//
// The behavior is react-free: `signal`/`computed` from brustjs/store (the window
// singleton on the client), `client` from brustjs/client (the treaty action
// client — also react-free), and the shared teamStore. NO react imports.
import { Plus } from 'lucide-react'
import { client } from 'brustjs/client'
import { computed, signal } from 'brustjs/store'
import type { Actions } from '../actions'
import type { AddTeamProps, TeamMember } from '../lib/types'
import { teamStore } from '../stores/team'

const api = client<Actions>()

const BASE =
  'inline-flex w-full items-center justify-center rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-600 disabled:opacity-50'
const IN_TEAM =
  'inline-flex w-full items-center justify-center rounded-lg bg-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors disabled:opacity-50 dark:bg-slate-700 dark:text-slate-100'

// behavior → client bundle, registered as "addToTeamButton" (camelCase filename).
// `props` is the object parsed out of the element's x-props attribute (the
// compiler serializes the loader's structured object via `json_attr`).
export const behavior = ({ props }: { props: AddTeamProps }) => {
  const busy = signal(false)
  const full = signal(false)
  const inTeam = computed(() =>
    ((teamStore.members() ?? []) as TeamMember[]).some((m) => m.id === props.id),
  )
  const disabled = computed(() => busy() || ((teamStore.members()?.length ?? 0) >= 6 && !inTeam()))
  const label = computed(() =>
    inTeam() ? 'In your team' : disabled() || full() ? 'Team Full' : 'Add to team',
  )
  const btnClass = computed(() => (inTeam() ? IN_TEAM : BASE))

  async function init() {
    const r = await api.team.get()
    if (r.data) teamStore.members.set(r.data.team)
  }

  async function toggle() {
    busy.set(true)
    try {
      if (inTeam()) {
        const { data } = await api.team({ id: props.id }).delete()
        if (data) teamStore.members.set(data.team)
      } else {
        const { data, error } = await api.team.post({
          id: props.id,
          name: props.name,
          displayName: props.displayName,
          num: props.num,
          types: props.types,
          artwork: props.artwork,
        })
        if (data) {
          full.set(false)
          teamStore.members.set(data.team)
        } else if (error?.value.code === 'TEAM_FULL') {
          full.set(true)
        }
      }
    } finally {
      busy.set(false)
    }
  }

  return { init, label, btnClass, toggle, disabled, full }
}

// default → jinja (server). The x-* directives are static string attributes the
// native compiler passes straight through; the directive runtime binds them to
// the behavior instance on the client. `data` is the loader's structured object,
// emitted by the compiler as x-props="{{ (data) | json_attr }}" (XSS-safe).
export default function AddToTeamButton({ data }: { data: AddTeamProps }) {
  return (
    <div x-data="addToTeamButton" x-props={data} className="relative">
      <Plus
        size={16}
        className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-white"
        isr={{ key: 'LcIconPlus' }}
      />
      <button
        type="button"
        x-text="label"
        x-bind-class="btnClass"
        x-bind-disabled="disabled"
        x-on-click="toggle"
        className="inline-flex w-full items-center justify-center rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-600 disabled:opacity-50"
      >
        Add to team
      </button>
    </div>
  )
}
