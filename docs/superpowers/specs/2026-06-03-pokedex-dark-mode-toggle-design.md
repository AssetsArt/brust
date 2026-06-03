# B4 — pokedex dark-mode toggle (dogfood)

> Status: design · 2026-06-03 · branch `feat/pokedex-dark-mode-toggle` (stacked on B3 `feat/s6-request-context-cookies` — needs `cookies.set`)
> Gap: FRAMEWORK-GAPS dark-mode toggle (framework UNBLOCKED by data-* on `<html>` + B3 cookies; this is the app-level composite).

## Goal

Real light/dark toggle in pokedex — proving the shipped primitives compose: **data-* on `<html>`**
(native `<BrustPage data-mode={mode}>`), **B3 `cookies.set`** (persist), **native `x-on-click`
directive** (instant client flip, no reload). Server reads the cookie → renders the right mode →
**no flash** on reload/SPA-nav.

## Non-goals
- No framework change — pure app dogfood (uses only shipped APIs: data-*, cookies, native directives).
- No system-preference (`prefers-color-scheme`) auto-detect — explicit toggle only (cookie default 'dark', current look).
- No per-component theming beyond the existing `[data-mode]`/`.dark` CSS layer.

## Architecture / changes (all in `example/pokedex/`)

### 1. `app.css` — drive theme by `[data-mode="dark"]`
Today dark rules are under `.dark` (line ~331) and `<BrustPage className="dark">` hardcodes it. Switch
the dark selector to **`[data-mode="dark"]`** (the shipped data-* hook; design's original intent). Keep
light as the default (`:root`). Replace `.dark` → `[data-mode="dark"]` for the dark override block + the
`.dark .x` descendant rules → `[data-mode="dark"] .x`. (light mode already exists as the `:root` defaults.)

### 2. `actions.ts` — `/theme` POST action (persists cookie via B3)
```ts
.post('/theme', ({ body }) => {
  cookies.set('mode', body.mode, { path: '/', maxAge: 31536000, sameSite: 'Lax' })
  return { mode: body.mode }
}, { body: z.object({ mode: z.enum(['dark', 'light']) }) })
```
import `cookies` from `brustjs`.

### 3. `lib/loaders.ts` + `lib/types.ts` — `mode` in chrome context
- `ChromeData` (added in native-Outlet T5): add `mode: 'dark' | 'light'`.
- Each leaf loader reads `req.cookies.mode`: `const mode = req.cookies.mode === 'light' ? 'light' : 'dark'`
  (default dark) → include in the chrome fields it returns. Loaders take ctx `{ params, path, req }` — `req` available.

### 4. `components/AppLayout.tsx` — data-mode + toggle control
- `<BrustPage data-mode={mode}>` (member-path from merged context) — drop hardcoded `className="dark"`.
  (data-* on `<html>` is shipped; `data-mode={mode}` member-path works.)
- Add a toggle control in the topbar: a native directive component `ThemeToggle` (single-file behavior,
  like `AddToTeamButton`) — `<button x-data="themeToggle" x-on-click="toggle">`.

### 5. `components/ThemeToggle.tsx` — native `x-on-click` behavior (no React)
```ts
import { client } from 'brustjs/client'
import { signal } from 'brustjs/store'
import type { Actions } from '../actions'
const api = client<Actions>()
export const behavior = () => {
  const mode = signal(document.documentElement.dataset.mode ?? 'dark')
  const label = computed(() => (mode() === 'dark' ? '☀ Light' : '🌙 Dark'))
  async function toggle() {
    const next = mode() === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.mode = next   // instant flip, no reload
    mode.set(next)
    await api.theme.post({ mode: next })            // persist cookie (server renders right mode next load)
  }
  return { toggle, label }
}
export default function ThemeToggle() {
  return <button class="aa-btn aa-btn--sm" x-data="themeToggle" x-on-click="toggle" x-text="label" />
}
```
(verify the exact native directive attr names against `AddToTeamButton.tsx` — `x-on-click`/`x-text`/`x-data`.)

## Tests / verification
- No new framework unit tests (dogfood). The acceptance is build + live smoke.
- `bun run ci` (biome) clean; pokedex build success.
- **Live smoke (required):** boot pokedex (`BRUST_PORT=1337`), `curl /` → `<html ... data-mode="dark">`
  (default); set cookie `mode=light` (curl `-b 'mode=light'`) → `<html ... data-mode="light">` (server
  reads cookie, no hardcode); the `/theme` POST returns 200 + `Set-Cookie: mode=...`; the ThemeToggle
  button + directive markup present. Browser (if available): click toggle → instant flip + persists across reload.

## Acceptance criteria
1. `bun run ci` clean; pokedex build success (native routes compile incl ThemeToggle directive).
2. `curl /` default → `data-mode="dark"`; `curl -b 'mode=light' /` → `data-mode="light"` (cookie-driven, no flash).
3. `curl -X POST /_brust/action/theme -d '{"mode":"light"}'` → 200 + `Set-Cookie: mode=light` (B3 flush).
4. ThemeToggle is a native directive (no React island) — view-source has `x-data="themeToggle"`, no `comp_` SSR.
5. SPA-nav preserves mode (cookie read on each nav render).

## Known limitations
- toggle persists via an action POST (client flips instantly, server cookie lags by one request — acceptable; the instant DOM flip masks it).
- no system-pref auto-detect; explicit only.
- depends on B3 (cookies) — stacked PR; merge B3 first.

## Open questions → resolved
- **instant flip vs reload?** client `x-on-click` flips `document.documentElement.dataset.mode` immediately
  (no reload) + persists cookie async — best UX, dogfoods native directives. (vs a server round-trip link =
  full reload; rejected for UX.)
- **default mode?** cookie absent → 'dark' (preserves the current pokedex look; no behavior change for existing users).
