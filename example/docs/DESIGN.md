# DESIGN — brust docs site tokens

Spec §Visual (docs/superpowers/specs/2026-06-11-docs-site-md-design.md) is
BINDING; this file translates it into the tokens implemented in `app.css`.
Named reference: **"chain-builder green over a grainient field."** The greens
are inherited brand identity; everything else follows reflex-reject rules.

## Palette (OKLCH, dark default)

Scene: developers reading docs at night next to an editor → dark is the
`:root` default (no `data-theme` attribute needed); light is opt-in via
`<html data-theme="light">`.

| token | dark (default) | light | notes |
|---|---|---|---|
| `--bg` | `oklch(0.16 0.012 170)` | `oklch(0.985 0 0)` | dark = near-black, brand-hue chroma ≤ 0.015; light = true off-white, chroma 0 — NOT cream |
| `--surface` | `oklch(0.20 0.014 170)` | `oklch(0.96 0 0)` | cards, code blocks, sidebar hover |
| `--fg` | `oklch(0.93 0.006 170)` | `oklch(0.22 0.01 170)` | body ≥ 4.5:1 against `--bg` in both themes |
| `--fg-muted` | `oklch(0.72 0.012 170)` | `oklch(0.45 0.01 170)` | secondary text; still ≥ 4.5:1 |
| `--line` | `oklch(0.30 0.014 170)` | `oklch(0.88 0 0)` | hairlines, table borders, callout borders |
| `--link` | `oklch(0.85 0.13 165)` (`#46e7b4`-class) | `oklch(0.46 0.09 168)` (`#0d684b`-class) | brand green, theme-flipped |
| `--accent` | `oklch(0.52 0.11 168)` (`#139069`-class, darkened) | same | solid CTA fill, both themes. Darkened a step from raw `#139069`: white text on `#139069` measures ≈4.0:1, under the binding 4.5:1; at L 0.52 `--accent-fg` clears it |
| `--accent-fg` | `oklch(0.985 0 0)` | same | text on `--accent` |

Grainient trio (WebGL uniforms, NOT CSS): `#1bcf96 / #27aeff / #08050b` —
ported verbatim from chain-builder in `GrainientBackground.tsx`.

## Typography

- **Family:** Schibsted Grotesk (display + body; weight contrast carries
  hierarchy) + Spline Sans Mono (code). Self-hosted woff2 in `public/fonts`
  (latin subset, @fontsource builds: Schibsted 400/500/700 + italics, mono
  400/600), `font-display: swap`; the token stacks keep `system-ui` /
  `ui-monospace` fallbacks for pre-swap paint and missing glyphs.
- **Scale:** 1.25 ratio from 1rem body —
  `0.8 / 1 / 1.25 / 1.5625 / 1.953 / 2.441 / 3.052 rem`
  (`--text-sm/base/lg/xl/2xl/3xl/4xl`).
- **Hero:** `clamp(2.75rem, 1rem + 6vw, 5.5rem)` — max ≤ 5.5rem (binding).
- Display letter-spacing ≥ `-0.03em` (we use `-0.02em`); `text-wrap: balance`
  on h1–h3, `text-wrap: pretty` on prose; measure ≤ 72ch.
- NO gradient text, anywhere.

## Spacing

Tailwind's default 0.25rem step is the spacing system. Page rhythm:
- prose block gap `1.25rem`; section gap `4rem`+; docs content pad `2.5rem`.
- Hit areas ≥ 40px (nav links, toggle, palette rows).

## Radius

`--radius-card: 12px` is the MAXIMUM. Cards/code blocks 12px, controls 8px,
hairline chips 6px. No 1px-border + ≥16px-blur shadow pairs.

## Z-index scale

`--z-nav: 10; --z-palette-backdrop: 40; --z-palette: 50`. Nothing else gets a
z-index.

## Motion

- The grainient hero is THE page-load moment. Everything else:
  ≤ 200ms, `--ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1)`.
- No scroll-reveal scaffolding. Content never gated on animation.
- ONE sanctioned continuous loop: the Home unified-store connector pulses
  (`.connector-pulse`, 2.8s linear, CSS-only SVG stroke-dash travel).
  Reduced motion removes the pulse stroke; the static hairline stays.
- `prefers-reduced-motion: reduce` → grainient renders ONE frame (no RAF);
  all CSS transitions/animations forced instant.

## Component rules (bans honored)

- Glass: the Home pill navbar over the grainient is the ONE glass use; docs
  header is plain solid `--bg` + hairline.
- Callouts: background tint + FULL hairline border (no side-stripes).
- Tables (GFM): hairline `--line` borders, `--surface` header row, no zebra.
- Code (shiki dual-theme): dark vars applied by default
  (`html:not([data-theme="light"])` scope), shiki's inline light colors as-is
  under `[data-theme="light"]`.
- Features section: bento card grid (nextjs.org card language in our colors)
  — varied spans (one 2×2 lead card carrying the measured req/s number) plus
  ONE dark highlight card (release notes link; stays dark in both themes,
  `.bento-highlight`). Typography-led: NO icons, no uppercase tracked
  eyebrows, no numbered section scaffolding.
- Home blueprint guides: sections below the hero sit in `.home-guides`
  (dashed `--line` hairlines at the content edges, md+) with `.home-fold`
  dashed separators and `.guide-mark` circle marks at the intersections —
  decorative, very low contrast, never inside the hero.
- Hero copy command (`CopyCommand`): mono `bun create brustjs my-app` with a
  click-to-copy behavior; the "Copied" hint is a text swap (≤1.2s), not an
  animation loop.

## A11y

Skip link; `<nav aria-label="Docs">`; `aria-current="page"` from precomputed
active flags; palette is a `<dialog>` with focus trap; contrast verified with
computed colors at polish time.
