export default function Facts() {
  return (
    <div className="wrap facts">
      <div>
        <b>0 KB</b>
        <span>client JavaScript on a page that only reads data</span>
      </div>
      <div>
        <b>3 tiers</b>
        <span>static, native, island, decided per component</span>
      </div>
      <div>
        <b>Rust + Bun</b>
        <span>Rust serves, routes, caches and renders; Bun runs your loaders and actions</span>
      </div>
      <div>
        <b>React 19</b>
        <span>real React in islands, nothing forked or patched</span>
      </div>
    </div>
  )
}
