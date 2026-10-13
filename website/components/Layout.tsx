// The document root for every site page: <html>, fonts and CSS, the site header, <Outlet/> for the page, the footer.
// layoutLoader supplies the @brust/core version and a default title; a page loader's `title` wins (child keys win).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type LoaderCtx, Outlet } from '@brust/core/routes'
import { absolute } from '../lib/site'
import SiteFooter from './SiteFooter'
import SiteHeader from './SiteHeader'

// Fonts: Chakra Petch (display), Zen Old Mincho (text), Azeret Mono (code, labels), one stylesheet each.

let version: string | undefined
function coreVersion(): string {
  if (version === undefined) {
    // @brust/core does not export its package.json; walk up from its resolved entry.
    let dir = dirname(Bun.resolveSync('@brust/core', import.meta.dir))
    while (version === undefined) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        if (pkg.name === '@brust/core') version = String(pkg.version)
      } catch {}
      const up = dirname(dir)
      if (up === dir) version = ''
      dir = up
    }
  }
  return version
}

export interface LayoutData {
  title: string
  version: string
  /** The page's absolute URL on the production origin (lib/site.ts): canonical and og:url below. */
  url: string
}

export async function layoutLoader({ path }: LoaderCtx): Promise<LayoutData> {
  return { title: 'brust', version: coreVersion(), url: absolute(path) }
}

export default function Layout({ title, version, url }: LayoutData) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <link rel="canonical" href={url} />
        <meta property="og:url" content={url} />
        <meta property="og:title" content={title} />
        <meta property="og:site_name" content="brust" />
        <link rel="icon" href="/public/favicon.svg" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Nunito:wght@300..900&display=swap" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Azeret+Mono:wght@400;500;600;700&display=swap" />
      </head>
      <body>
        <SiteHeader version={version} />
        <main>
          <Outlet />
        </main>
        <SiteFooter />
      </body>
    </html>
  )
}
