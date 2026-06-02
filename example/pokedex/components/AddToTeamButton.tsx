// NATIVE INTERACTIVE COMPONENT (Spec B dogfood) — the "Add to team / In your
// team" toggle on the detail page. Formerly a React island; now a single-file
// native directive component: a co-located `export const behavior` (client
// logic, react-free) + a JSX `default` export (the native template the compiler
// lowers to minijinja). The build bundles ONLY `behavior` into _directives.js;
// the JSX default is tree-shaken out so react never leaks into the client bundle.
//
// The behavior is react-free: `signal`/`computed` from brustjs/store (the window
// singleton on the client), `client` from brustjs/client (the treaty action
// client — also react-free), and the shared teamStore. NO react imports.
import { client } from 'brustjs/client'
import { computed, signal } from 'brustjs/store'
import type { Actions } from '../actions'
import type { AddToTeamProps } from '../lib/types'
import { teamStore } from '../stores/team'

const api = client<Actions>()

// behavior → client bundle, registered as "addToTeamButton" (camelCase filename).
// `props` is the JSON parsed out of the element's x-props attribute (precomputed
// by the loader as a JSON string — native templates can't call JSON.stringify).
export const behavior = ({ props }: { props: AddToTeamProps }) => {
  // Shared store (GAP S4): writing teamStore.members here is observed by the
  // TeamBuilder island — they resolve the same window singleton. A native
  // x-on-click mutation is therefore seen reactively by a React island.
  const busy = signal(false)
  const toast = signal<string | null>(null)
  const inTeam = computed(() => (teamStore.members() ?? []).some((m) => m.id === props.id))
  const label = computed(() => (inTeam() ? '✓ In your team' : '＋ Add to team'))
  const btnClass = computed(() => `aa-btn aa-btn--full${inTeam() ? ' aa-btn--secondary' : ''}`)
  const showToast = computed(() => toast() !== null)

  async function init() {
    const r = await api.team.get()
    if (r.data) teamStore.members.set(r.data.team)
  }

  async function toggle() {
    busy.set(true)
    try {
      if (inTeam()) {
        // Bodyless DELETE is OK now (GAPS S12 fixed) — no more `.delete({})`.
        const { data } = await api.team({ id: props.id }).delete()
        if (data) teamStore.members.set(data.team)
      } else {
        const { data } = await api.team.post({
          id: props.id,
          name: props.name,
          displayName: props.displayName,
          num: props.num,
          types: props.types,
          artwork: props.artwork,
        })
        if (data?.full) {
          toast.set('ทีมเต็มแล้ว · สูงสุด 6 ตัว')
          setTimeout(() => toast.set(null), 2200)
        } else if (data) {
          teamStore.members.set(data.team)
        }
      }
    } finally {
      busy.set(false)
    }
  }

  return { busy, toast, inTeam, label, btnClass, showToast, init, toggle }
}

// default → jinja (server). The x-* directives are static string attributes the
// native compiler passes straight through; the directive runtime binds them to
// the behavior instance on the client. `data` is the loader-precomputed JSON
// string, emitted by the compiler as x-props="{{ (data) | e }}" (XSS-safe).
export default function AddToTeamButton({ data }: { data: string }) {
  return (
    <div x-data="addToTeamButton" x-props={data} style={{ position: 'relative' }}>
      <button
        type="button"
        x-text="label"
        x-bind-class="btnClass"
        x-bind-disabled="busy"
        x-on-click="toggle"
        className="aa-btn aa-btn--full"
        style={{ width: '100%' }}
      >
        ＋ Add to team
      </button>
      <div
        x-show="showToast"
        x-text="toast"
        style={{
          position: 'absolute',
          top: 'calc(100% + 8px)',
          left: 0,
          right: 0,
          zIndex: 50,
          padding: '8px 12px',
          borderRadius: 'var(--radius-md)',
          background: 'var(--danger-50)',
          color: 'var(--danger-700)',
          border: '1px solid rgba(212,28,89,0.25)',
          fontSize: 'var(--text-xs)',
          fontWeight: 600,
          textAlign: 'center',
          boxShadow: 'var(--shadow-md)',
        }}
      />
    </div>
  )
}
