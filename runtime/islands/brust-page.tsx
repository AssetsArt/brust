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
  /** Page body — rendered inside `<body>`. */
  children?: ReactNode
}

export function BrustPage({
  lang = 'en',
  className,
  bodyClassName,
  title,
  description,
  children,
}: BrustPageProps): ReactNode {
  return createElement(
    'html',
    { lang, className },
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
    ),
    createElement('body', { className: bodyClassName }, children),
  )
}
