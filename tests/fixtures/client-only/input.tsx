export default function Viewport() {
  const wide = window.innerWidth > 800
  return <p>{wide ? 'wide' : 'narrow'}</p>
}
