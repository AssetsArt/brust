export default function NativeProfile({ user, greeting }: { user: string; greeting: string }) {
  // The label is a string EXPRESSION `{'User: '}` so its trailing space survives
  // the jsx-rust-compiler's normalize_jsx_text (which trims whitespace between
  // adjacent Text and Expr nodes). Stable under Biome's formatter too.
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
