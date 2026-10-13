// Runs after `brust build --target static`, before the Pages upload: puts sitemap.xml and llms.txt at the site root
// (where crawlers and agents look for them) with a robots.txt that points at the sitemap, and marks every
// *.pages.dev host noindex so https://brust.dev is the only origin search engines keep.
import { copyFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { absolute } from '../lib/site'

const out = join(import.meta.dir, '..', 'dist', 'static')
for (const f of ['sitemap.xml', 'llms.txt']) copyFileSync(join(out, 'public', f), join(out, f))
writeFileSync(join(out, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${absolute('/sitemap.xml')}\n`)
appendFileSync(
  join(out, '_headers'),
  '\nhttps://:project.pages.dev/*\n  X-Robots-Tag: noindex\n\nhttps://:version.:project.pages.dev/*\n  X-Robots-Tag: noindex\n',
)
console.log('[site] dist/static: sitemap.xml, llms.txt, robots.txt at the root; *.pages.dev noindex')
