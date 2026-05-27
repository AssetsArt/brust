// Module-scope state for the dev-client <script> snippet that the renderer
// splices into the SSR first chunk in dev mode. Mirrors runtime/css.ts.
// Workers re-execute the bundle and get their own copy; brust.run() sets
// the snippet on both main and worker startup paths.
let snippet: string | null = null

/** Set the dev-client snippet (full `<script>…</script>` tag) the renderer
 * should inject before `</head>`. Pass `null` to disable injection (the
 * default in non-dev mode). */
export function configureDevClientSnippet(s: string | null): void {
  snippet = s
}

/** Returns the configured snippet, or `null` when dev mode is off. */
export function getDevClientSnippet(): string | null {
  return snippet
}
