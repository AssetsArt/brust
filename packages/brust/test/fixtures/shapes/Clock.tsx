// Reads a browser global in render ⇒ react tier, client_only (no server render).
export default function Clock() {
  return <time>{window.innerWidth}</time>
}
