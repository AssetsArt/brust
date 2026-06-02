// JSON for embedding in a <script> TEXT node (not an attribute). brust runs
// AutoEscape::None and a request-derived value can reach a serialized signal, so
// escape against </script> / <!-- breakout. See memory brust-jinja-autoescape-none.

const ESC: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
}

export function toScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => ESC[c])
}

export function storeScriptTag(name: string, state: unknown): string {
  // name comes from defineStore (developer literal), not request data; still
  // guard the attribute against quote breakout by rejecting unexpected chars.
  const safeName = String(name).replace(/[^a-zA-Z0-9_.:-]/g, '')
  return `<script type="application/json" data-brust-store="${safeName}">${toScriptJson(state)}</script>`
}

export function parseStoreScript(el: { textContent: string | null }): Record<string, unknown> {
  const text = el.textContent ?? '{}'
  return JSON.parse(text) as Record<string, unknown>
}
