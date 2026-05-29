export default function NativeProfile({ user, greeting }: { user: string; greeting: string }) {
  // Note: the label is a string EXPRESSION `{'User: '}` (not plain text) so the
  // trailing space survives the jsx-rust-compiler's `normalize_jsx_text`
  // (lower.rs), which collapses + trims whitespace between adjacent Text and
  // Expr nodes. A plain `User: {user}` would compile to `User:{{ user }}` (no
  // space). The earlier `{" "}` hack worked too but Biome's formatter collapses
  // it back into a literal space; a string-literal expr is stable under both.
  return (
    <div>
      <h1>{greeting}</h1>
      <p>
        {'User: '}
        {user}
      </p>
    </div>
  )
}
