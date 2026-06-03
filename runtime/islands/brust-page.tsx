import { createElement, type ReactNode } from 'react'

/** Props for the built-in `<BrustPage>` document shell.
 *
 * `<BrustPage>` is a NATIVE-route document component: in a `native: true` route
 * the Rust JSX compiler intercepts the `BrustPage` tag and emits the whole
 * `<html>/<head>/<body>` skeleton itself, auto-injecting the framework head tags
 * (charset, viewport, the `/_brust/css/app.css` stylesheet link). The head is
 * configured ENTIRELY through these props — you never write `<head>` markup, so
 * brust keeps full ownership of `<head>` and can add more tags later (importmap,
 * preloads) without colliding with hand-written head elements.
 *
 * On the native path each prop accepts a compile-time string literal OR a
 * loader member-path (`title={data.title}`), interpolated into the Rust-rendered
 * shell as `{{ path }}` (S8). Calls/arithmetic are still rejected. This React
 * implementation mirrors the compiled output for the rare non-native use. */
/** One extra `<head>` element for `<BrustPage head={[…]}>`. Discriminated by
 * `tag`. On the native path, attribute values may be a string literal or a
 * loader member-path (HTML-escaped); `text` (inner content of style/script/
 * noscript) must be a static string literal (raw — never user input). */
export type HeadEntry =
  | {
      tag: 'link'
      rel: string
      href: string
      type?: string
      sizes?: string
      as?: string
      media?: string
      crossOrigin?: string
    }
  | { tag: 'meta'; name?: string; property?: string; httpEquiv?: string; content: string }
  | { tag: 'base'; href?: string; target?: string }
  | { tag: 'style'; text: string; media?: string }
  | {
      tag: 'script'
      src?: string
      text?: string
      type?: string
      defer?: boolean
      async?: boolean
      crossOrigin?: string
    }
  | { tag: 'noscript'; text: string }

export interface BrustPageProps {
  /** `<html lang>` — defaults to `"en"`. */
  lang?: string
  /** `<html class>` (e.g. `"dark"`). */
  className?: string
  /** `<body class>`. */
  bodyClassName?: string
  /** `<title>…</title>`. Omitted when absent. */
  title?: string
  /** `<meta name="description" content="…">`. Omitted when absent. */
  description?: string
  /** Extra `<head>` elements (link/meta/base/style/script/noscript). */
  head?: HeadEntry[]
  /** Page body — rendered inside `<body>`. */
  children?: ReactNode
  /** Arbitrary `data-*` on `<html>` (e.g. `data-mode="dark"`). String literal
   *  or loader member-path on the native path. */
  [dataAttr: `data-${string}`]: string | undefined
}

/** React mirror of one head entry (non-native path). Native routes emit these
 * in Rust; this keeps the rare React render in sync. */
function headEntryToElement(entry: HeadEntry, key: number): ReactNode {
  const { tag, ...rest } = entry
  if (tag === 'style' || tag === 'script' || tag === 'noscript') {
    const { text, ...attrs } = rest as { text?: string } & Record<string, unknown>
    return createElement(tag, { key, ...attrs }, text ?? undefined)
  }
  return createElement(tag, { key, ...rest })
}

export function BrustPage({
  lang = 'en',
  className,
  bodyClassName,
  title,
  description,
  head,
  children,
  ...rest
}: BrustPageProps): ReactNode {
  const dataAttrs = Object.fromEntries(Object.entries(rest).filter(([k]) => k.startsWith('data-')))
  return createElement(
    'html',
    { lang, className, ...dataAttrs },
    createElement(
      'head',
      null,
      createElement('meta', { charSet: 'utf-8' }),
      createElement('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
      title != null ? createElement('title', null, title) : null,
      description != null
        ? createElement('meta', { name: 'description', content: description })
        : null,
      createElement('link', { rel: 'stylesheet', href: '/_brust/css/app.css' }),
      ...(head ?? []).map((entry, i) => headEntryToElement(entry, i)),
    ),
    createElement('body', { className: bodyClassName }, children),
  )
}
