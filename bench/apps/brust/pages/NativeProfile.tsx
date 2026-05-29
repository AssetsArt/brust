export default function NativeProfile({ user, greeting }: { user: string; greeting: string }) {
  // `{" "}` keeps the boundary space between `User:` and `{user}` — the
  // jsx-rust-compiler's normalize_jsx_text collapses adjacent-node whitespace.
  return (
    <div>
      <h1>{greeting}</h1>
      <p>User:{" "}{user}</p>
    </div>
  )
}
