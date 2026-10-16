// F277 (Afrojack, Mellow residual 1): a style object keeps its source order, so the shorthand written after its
// longhand wins (margin-top 0), as in React; a key-sorted map would print margin before margin-top (top 5px).
export default function Margin({ style }: { style?: { width?: number } }) {
  return <i data-testid="margin" style={{ marginTop: 5, margin: 0, display: 'block', ...style }} />
}
