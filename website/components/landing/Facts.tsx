export default function Facts() {
  return (
    <div className="wrap facts">
      <div>
        {/* Measured 2026-10-13: /demo/pokemon/pikachu (all static) ships no <script>; runtime-dom is 17.5 KB raw, 5.9 KB gzip -9. */}
        <b>0 KB</b>
        <span>JavaScript on a page with nothing interactive. The 6 KB runtime loads only where a component needs it</span>
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
