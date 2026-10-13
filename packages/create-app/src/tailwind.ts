// Tailwind CSS v4 in the blank template (gaps round L21, made the default by L28 R29.1): the template ships `app.css`
// (`@import "tailwindcss"` + `@theme` tokens), the layout imports it (brust builds it and links it in <head>, L19), and
// the two pinned dev dependencies below are in its package.json (R21.1: the app's own). `--tailwind` no longer changes
// anything; it prints TAILWIND_DEFAULT_NOTE.

/** The exact versions brust's own tests build with (the blank template's package.json pins the same). */
export const TAILWIND_DEV_DEPS = { 'bun-plugin-tailwind': '0.1.2', tailwindcss: '4.3.3' }

export const TAILWIND_DEFAULT_NOTE = 'create-app: Tailwind CSS v4 is the default; the --tailwind flag does nothing'
