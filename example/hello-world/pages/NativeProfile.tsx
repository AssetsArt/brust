export default function NativeProfile({ user, greeting }: { user: string; greeting: string }) {
  // Note: `{" "}` is required between `User:` and `{user}` because the
  // jsx-rust-compiler's `normalize_jsx_text` (lower.rs) collapses JSX
  // whitespace via `split_whitespace().join(" ")`, which strips the
  // boundary space between adjacent Text("User:") and Expr(user). The
  // explicit `{" "}` lowers to `Expr::StaticText(" ")` which emit_jinja
  // renders as a literal escaped space. Spec §5 deferral.
  return (
    <div>
      <h1>{greeting}</h1>
      <p>User:{" "}{user}</p>
    </div>
  )
}
