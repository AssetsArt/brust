// Search index generator — runs at routes-module import time (main process
// only, `if (!isWorker)` at the call site in routes.tsx) and writes
// public/search-index.json so the file exists in dev, in dist/public (build.ts
// imports routes.tsx BEFORE the public copy), and in SSG output.
//
// scanMdDir is NOT public brustjs API — relative import into the framework
// repo (logged in FRAMEWORK-GAPS.md: "no public md scan/slug export").
// Known caveat (accepted, spec §Search index): regenerates per boot/build,
// not on md hot-edit — restart picks edits up.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { scanMdDir } from '../../../runtime/md/scan.ts'

export interface SearchHeading {
  text: string
  anchor: string
}

export interface SearchEntry {
  title: string
  path: string
  headings: SearchHeading[]
}

/**
 * Copied VERBATIM from runtime/md/render.ts:400-406 (`slugify`) — anchors in
 * the index MUST byte-match the ids render.ts stamps on <h2>/<h3>. `\w` is
 * ASCII-only there too (non-ascii heading text strips to nothing).
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]/g, '')
}

/**
 * Inline-markdown → plain text, approximating what render.ts's heading
 * renderer slugs: it calls `parser.parseInline(tokens, parser.textRenderer)`
 * (render.ts:428), i.e. marked's text renderer — link/image syntax collapses
 * to its TEXT (the url vanishes), code spans keep their content, emphasis
 * markers disappear, and `&` stays RAW (verified against a real render:
 * "Install & Run" → "install--run", not "install-amp-run").
 */
function plainHeadingText(raw: string): string {
  return (
    raw
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images → alt text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // inline links → link text
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1') // reference links → link text
      .replace(/`+/g, '') // code spans → content
      .replace(/\*\*|\*|~~/g, '') // emphasis markers (slugify strips these anyway)
      // _em_ pairs: `_` is \w (slugify KEEPS it), so paired emphasis must drop
      // here. \b_ only matches at a non-word boundary — intraword snake_case
      // stays, matching marked GFM ("snake_case heading" → "snake_case-heading",
      // "The _em_ part" → "the-em-part"; both verified against a real render).
      .replace(/\b_([^_]+)_\b/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .trim()
  )
}

/**
 * Extracts h2/h3 headings (text + anchor) from an md body.
 *
 * - ATX headings only (` {0,3}#{1,6} `), trailing closing `#`s stripped —
 *   matches what marked GFM sees; 4-space-indented lines are code.
 * - Lines inside ``` / ~~~ fences are shielded (closing fence must repeat the
 *   opening char at least as many times).
 * - The dedupe counter replicates render.ts:410/429-432 exactly: page-local,
 *   shared across ALL heading depths (an h1 "Setup" makes a later h2 "Setup"
 *   slug to "setup-2"), suffixes `-2, -3, …`. h1/h4-h6 feed the counter but
 *   are not emitted.
 */
export function extractHeadings(body: string): SearchHeading[] {
  const slugCounts = new Map<string, number>()
  const out: SearchHeading[] = []
  let fence: { char: string; len: number } | null = null

  for (const line of body.split('\n')) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1] as string
      const char = marker[0] as string
      if (fence === null) {
        fence = { char, len: marker.length }
        continue
      }
      // Closing fence: same char, at least the opening length, nothing else.
      if (
        char === fence.char &&
        marker.length >= fence.len &&
        line.trim().replace(new RegExp(`\\${char}`, 'g'), '') === ''
      ) {
        fence = null
      }
      continue
    }
    if (fence !== null) continue

    const m = /^ {0,3}(#{1,6})\s+(.*?)\s*$/.exec(line)
    if (m === null) continue
    const depth = (m[1] as string).length
    const text = plainHeadingText((m[2] as string).replace(/\s+#+\s*$/, ''))

    const base = slugify(text)
    const seen = slugCounts.get(base) ?? 0
    slugCounts.set(base, seen + 1)
    const anchor = seen === 0 ? base : `${base}-${seen + 1}`
    if (depth === 2 || depth === 3) out.push({ text, anchor })
  }
  return out
}

/**
 * relPath → URL. Mapping rules copied from runtime/md/routes.ts:28-36
 * (`mdUrlPath`, not public API): strip `.md`, `index` → the prefix itself,
 * `a/index` → `<prefix>/a`, otherwise `<prefix>/<route>`.
 */
function urlPath(relPath: string, prefix: string): string {
  let base = prefix.replace(/\/+$/, '')
  if (base !== '' && !base.startsWith('/')) base = `/${base}`
  let route = relPath.replace(/\.md$/, '')
  if (route === 'index') route = ''
  else if (route.endsWith('/index')) route = route.slice(0, -'/index'.length)
  const url = route === '' ? base : `${base}/${route}`
  return url === '' ? '/' : url
}

export interface GenerateSearchIndexOptions {
  /** Defaults module-relative (NOT cwd): `<example/docs>/content`. */
  contentDir?: string
  /** Defaults module-relative: `<example/docs>/public/search-index.json`. */
  outFile?: string
  /** URL prefix the md pages mount under. Default '/docs' (routes.tsx). */
  prefix?: string
}

/**
 * Scans the content dir and writes the search index (compact JSON, entries
 * sorted by relPath — scanMdDir's order, so output is deterministic). SAFE at
 * import time: any failure logs loudly and returns [] instead of throwing —
 * a broken index must never kill server boot.
 */
export function generateSearchIndex(opts: GenerateSearchIndexOptions = {}): SearchEntry[] {
  const contentDir = opts.contentDir ?? path.join(import.meta.dir, '..', 'content')
  const outFile = opts.outFile ?? path.join(import.meta.dir, '..', 'public', 'search-index.json')
  const prefix = opts.prefix ?? '/docs'
  try {
    const entries: SearchEntry[] = scanMdDir(contentDir).map((f) => ({
      title:
        typeof f.frontmatter.title === 'string'
          ? f.frontmatter.title
          : (f.relPath.replace(/\.md$/, '').split('/').pop() ?? f.relPath),
      path: urlPath(f.relPath, prefix),
      headings: extractHeadings(f.body),
    }))
    mkdirSync(path.dirname(outFile), { recursive: true })
    writeFileSync(outFile, JSON.stringify(entries))
    return entries
  } catch (err) {
    console.error(
      `[docs] search-index generation FAILED (continuing without index): ${(err as Error).stack ?? err}`,
    )
    return []
  }
}
