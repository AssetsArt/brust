// components/NavLink.tsx — static; `active` is computed in the loader from `path` (no client nav in M2).
const BASE = 'inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
const ACTIVE = 'inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-semibold text-brand-600 bg-brand-50 dark:text-brand-50 dark:bg-brand-600/20'
export default function NavLink(props: { href: string; label: string; active: boolean }) {
  return <a href={props.href} data-active={props.active ? '1' : '0'} className={props.active ? ACTIVE : BASE}>{props.label}</a>
}
