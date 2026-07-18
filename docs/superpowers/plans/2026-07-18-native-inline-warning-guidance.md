# Actionable native-inline fallback warnings

owner: 0ddb11d0-954b-4710-90ce-8191a46fe3c3 · authority: explicit-human-request

## Goal

When a native component cannot inline and Brust falls back to React SSR, present a readable, actionable warning that explains the reason, the client-interactivity consequence, and the two supported remedies: use an Island for React interactivity or rewrite the component as native-compatible JSX for zero-JS output.

## Decision

Keep compiler warning strings stable and machine-readable. Format only presentation in `runtime/cli/native-routes-emit.ts`, where warnings are currently printed as `brust: ${warning}`.

For a warning matching `native component "<Name>" not inlined: <reason>`, emit this semantic structure (wording may be polished without changing meaning):

```text
brust: warning — native component "MobileMenu" was not inlined
  reason: <compiler reason>
  impact: rendered through React SSR; React hooks and event handlers are not hydrated automatically on a native route
  interactive fix: use <Island component={MobileMenu} props={...} />
  zero-JS fix: rewrite MobileMenu using native-compatible JSX
```

Use plain text without ANSI color or emoji so CI logs, snapshots, and redirected stderr remain clean. Non-native-inline compiler warnings keep the existing one-line `brust: <warning>` format.

## File boundary

- `runtime/cli/native-routes-emit.ts`
- `tests/native-inline.test.ts`

## Required behavior

1. Add a small formatter/helper rather than embedding regex and string assembly in the emit loop.
2. Preserve the complete compiler reason verbatim, including backticks and remediation text.
3. State the impact condition precisely: React client behavior is not hydrated automatically; do not claim static server-rendered markup disappears.
4. Name the actual component in both suggested fixes.
5. Update existing native-inline stderr assertions and add one exact multiline assertion proving the reason, impact, Island suggestion, and native-compatible suggestion are emitted together.
6. Ensure ordinary warnings still use the existing single-line prefix.

## Verification

```bash
bun test tests/native-inline.test.ts
bun run ci
```

Both commands must exit 0. Record both as task gates and return a clean commit.
