export default function HeroSection({ title }: { title: string }) {
  // F2 (R3a) — local const binding hoisted by the compiler: the style object is
  // substituted into the style attr before lowering, so this inlines natively.
  const rootStyle = { background: '#fde68a', padding: '8px' }
  return (
    <header class="sec-hero" style={rootStyle}>
      <h2>{title}</h2>
    </header>
  )
}
