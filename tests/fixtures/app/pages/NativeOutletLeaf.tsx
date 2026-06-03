// T4 — native <Outlet> leaf fragment. A bare native fragment (NO BrustPage —
// the framework shell is owned by the parent layout). It renders an
// identifiable marker using a LEAF-loader field (`widget`). Seeing both this
// field AND the parent's `section` field in the composed document proves the
// chain loaders merged (T3).
export default function NativeOutletLeaf({ widget }: { widget: string }) {
  return <article className="leaf">widget: {widget}</article>
}
