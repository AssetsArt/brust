// Writes public/sitemap.xml and public/llms.txt from lib/site.ts before a build, so the static output (and the dev
// server, which serves /public) carries both at the site root paths /public/... AND, through _redirects written by
// `brust build --target static`, nothing else is needed: the files are plain static assets. Run by the `build` scripts.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { llmsTxt, sitemapXml } from '../lib/site'

const pub = join(import.meta.dir, '..', 'public')
mkdirSync(pub, { recursive: true })
writeFileSync(join(pub, 'sitemap.xml'), sitemapXml())
writeFileSync(join(pub, 'llms.txt'), llmsTxt())
console.log('[site] wrote public/sitemap.xml and public/llms.txt')
