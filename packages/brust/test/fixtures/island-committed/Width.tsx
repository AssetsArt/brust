// Reads a browser global in render: react tier, client_only (createRoot, no server render).
export default function Width() {
  return <p data-testid="width">{window.innerWidth > 0 ? 'wide' : 'none'}</p>
}
