import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface MdFile {
  /** Posix-separated path relative to the content dir, e.g. 'query/where.md'. */
  relPath: string
  absPath: string
  frontmatter: {
    title?: string
    description?: string
    nav?: { group?: string; order?: number }
    [k: string]: unknown
  }
  /** Markdown source after the frontmatter block is stripped. */
  body: string
}

/**
 * Recursively scans `contentDir` for `.md` files, sorted by `relPath`.
 *
 * Frontmatter is a leading `---` … `---` block parsed as a hand-rolled YAML
 * subset (NO yaml dependency):
 * - `key: value` lines; keys match `[A-Za-z0-9_-]+`
 * - values: double-quoted strings (JSON escapes), single-quoted strings (no
 *   escapes), bare strings, numbers, booleans
 * - one-level nested maps via the INLINE-BRACES form only, e.g.
 *   `nav: { group: "Getting Started", order: 1 }` — indented child keys are
 *   NOT supported and throw
 * - blank lines inside the block are ignored
 *
 * Files without a frontmatter block get `frontmatter: {}` and the whole file
 * as `body`. Malformed frontmatter throws with `<absPath>:<line>`. CRLF line
 * endings are tolerated.
 */
export function scanMdDir(contentDir: string): MdFile[] {
  const relPaths: string[] = []
  collectMd(contentDir, '', relPaths)
  relPaths.sort()
  return relPaths.map((relPath) => {
    const absPath = join(contentDir, relPath)
    const source = readFileSync(absPath, 'utf8')
    const { frontmatter, body } = splitFrontmatter(source, absPath)
    return { relPath, absPath, frontmatter, body }
  })
}

function collectMd(dir: string, relPrefix: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`
    if (entry.isDirectory()) collectMd(join(dir, entry.name), rel, out)
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(rel)
  }
}

function splitFrontmatter(
  source: string,
  absPath: string,
): { frontmatter: MdFile['frontmatter']; body: string } {
  // BOM would otherwise make the opening fence read '﻿---' and the whole
  // block silently fall through as body — common with Windows editors.
  const lines = source.replace(/^\uFEFF/, '').split('\n')
  // Fences tolerate trailing whitespace (and CRLF) — `--- ` is still a fence.
  const isFence = (line: string) => line.trimEnd() === '---'
  if (!isFence(lines[0] ?? '')) return { frontmatter: {}, body: source }

  let closeIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (isFence(lines[i] ?? '')) {
      closeIdx = i
      break
    }
  }
  if (closeIdx === -1) {
    throw new Error(`${absPath}:1 unterminated frontmatter block (missing closing ---)`)
  }

  const frontmatter: MdFile['frontmatter'] = {}
  for (let i = 1; i < closeIdx; i++) {
    const line = stripCr(lines[i] ?? '')
    const fileLine = i + 1
    if (line.trim() === '') continue
    const m = /^([A-Za-z0-9_-]+):(.*)$/.exec(line)
    if (m === null) {
      throw new Error(
        `${absPath}:${fileLine} malformed frontmatter line (expected 'key: value'): ${line.trim()}`,
      )
    }
    const key = m[1] as string
    const raw = (m[2] as string).trim()
    frontmatter[key] = raw.startsWith('{')
      ? parseInlineMap(raw, absPath, fileLine)
      : parseScalar(raw, absPath, fileLine)
  }

  const body = lines.slice(closeIdx + 1).join('\n')
  return { frontmatter, body }
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

function parseScalar(raw: string, absPath: string, fileLine: number): unknown {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) {
      throw new Error(`${absPath}:${fileLine} unterminated double-quoted string: ${raw}`)
    }
    try {
      return JSON.parse(raw)
    } catch {
      throw new Error(`${absPath}:${fileLine} invalid double-quoted string: ${raw}`)
    }
  }
  if (raw.startsWith("'")) {
    if (raw.length < 2 || !raw.endsWith("'")) {
      throw new Error(`${absPath}:${fileLine} unterminated single-quoted string: ${raw}`)
    }
    return raw.slice(1, -1)
  }
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  return raw
}

/** Parses the inline-braces map form: `{ key: value, key2: value2 }` (one level). */
function parseInlineMap(raw: string, absPath: string, fileLine: number): Record<string, unknown> {
  if (!raw.endsWith('}')) {
    throw new Error(`${absPath}:${fileLine} unterminated inline map (missing closing }): ${raw}`)
  }
  const inner = raw.slice(1, -1).trim()
  const map: Record<string, unknown> = {}
  if (inner === '') return map
  for (const entry of splitTopLevel(inner, absPath, fileLine)) {
    const m = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*:(.*)$/.exec(entry)
    if (m === null) {
      throw new Error(
        `${absPath}:${fileLine} malformed inline map entry (expected 'key: value'): ${entry.trim()}`,
      )
    }
    const key = (m[1] ?? m[2] ?? m[3]) as string
    const value = (m[4] as string).trim()
    if (value === '') {
      throw new Error(`${absPath}:${fileLine} inline map entry "${key}" has no value`)
    }
    map[key] = parseScalar(value, absPath, fileLine)
  }
  return map
}

/** Splits map entries on commas that sit outside quoted strings. */
function splitTopLevel(inner: string, absPath: string, fileLine: number): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (const ch of inner) {
    if (quote !== null) {
      current += ch
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      current += ch
      quote = ch
    } else if (ch === ',') {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (quote !== null) {
    throw new Error(`${absPath}:${fileLine} unterminated string inside inline map`)
  }
  parts.push(current)
  return parts
}
