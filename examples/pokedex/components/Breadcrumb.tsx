// components/Breadcrumb.tsx — static (no nav store in M2).
export default function Breadcrumb(props: { crumb: string }) {
  return <b className="text-slate-600 dark:text-slate-300">{props.crumb}</b>
}
