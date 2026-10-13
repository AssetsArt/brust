// A link styled as the canon button: square, mono caps; `primary` fills it amber. It lifts a pixel on hover (the
// primary one also casts an amber shadow), only when motion is allowed. The two class strings differ only in the
// colours and the shadow.
export default function Button({ href, label, primary }: { href: string; label: string; primary?: boolean }) {
  return (
    <a
      className={
        primary
          ? 'inline-flex min-h-[46px] items-center gap-2 rounded-none border border-amber-fill bg-amber-fill px-[1.15rem] py-[.7rem] font-mono text-[.72rem] font-bold uppercase tracking-[.08em] text-on-amber no-underline motion-safe:[transition-duration:.2s,.2s,.15s] motion-safe:[transition-property:translate,background-color,box-shadow] motion-safe:[transition-timing-function:var(--ease),var(--ease),ease] motion-safe:hover:-translate-y-px motion-safe:hover:shadow-[0_8px_18px_-10px_var(--amber)]'
          : 'inline-flex min-h-[46px] items-center gap-2 rounded-none border border-ink bg-transparent px-[1.15rem] py-[.7rem] font-mono text-[.72rem] font-bold uppercase tracking-[.08em] text-ink no-underline motion-safe:[transition-duration:.2s,.2s,.15s] motion-safe:[transition-property:translate,background-color,box-shadow] motion-safe:[transition-timing-function:var(--ease),var(--ease),ease] motion-safe:hover:-translate-y-px'
      }
      href={href}
    >
      {label}
    </a>
  )
}
