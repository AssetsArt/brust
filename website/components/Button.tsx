// A link styled as the canon button: square, mono caps; `primary` fills it amber.
export default function Button({ href, label, primary }: { href: string; label: string; primary?: boolean }) {
  return (
    <a className={primary ? 'btn primary' : 'btn'} href={href}>
      {label}
    </a>
  )
}
