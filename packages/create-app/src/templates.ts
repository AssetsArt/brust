// Template registry + selection (port of 0.1.x new.ts:165-220). `blank` is committed; `pokedex` is GENERATED from
// examples/pokedex by scripts/sync-template.ts (prepack, monorepo runs, tests) and gitignored.
import { join, resolve } from 'node:path'

export interface TemplateDef {
  name: string
  description: string
  dir: string
  /** true → produced by scripts/sync-template.ts, never hand-edited. */
  generated: boolean
}

export const DEFAULT_TEMPLATE = 'blank'

/** Test-only hook: point both templates at another directory (CREATE_APP_TEMPLATES_DIR) to exercise the copy-failure rollback. */
const templatesDir = (): string => process.env.CREATE_APP_TEMPLATES_DIR || resolve(import.meta.dir, '../templates')

export function listTemplates(): TemplateDef[] {
  const root = templatesDir()
  return [
    { name: 'blank', description: 'One page, a native counter, an Elysia hello action', dir: join(root, 'blank'), generated: false },
    { name: 'pokedex', description: 'The v2 Pokédex: loaders, L1 cache, native + island, the team store on Elysia actions + SQLite', dir: join(root, 'pokedex'), generated: true },
  ]
}

export interface SelectTemplateOpts {
  explicit?: string
  yes: boolean
  isTTY: boolean
  read?: (label: string) => string | null
  print?: (s: string) => void
}

export function selectTemplate(opts: SelectTemplateOpts): TemplateDef {
  const templates = listTemplates()
  if (opts.explicit !== undefined) {
    const t = templates.find((x) => x.name === opts.explicit)
    if (!t) throw new Error(`create-app: unknown template "${opts.explicit}" — choose one of: ${templates.map((x) => x.name).join(', ')}`)
    return t
  }
  if (opts.yes || !opts.isTTY) return templates.find((t) => t.name === DEFAULT_TEMPLATE) ?? templates[0]!
  const read = opts.read ?? ((label: string) => prompt(label))
  const print = opts.print ?? ((s: string) => process.stdout.write(s))
  return promptPicker(templates, read, print)
}

function promptPicker(templates: TemplateDef[], read: (label: string) => string | null, print: (s: string) => void): TemplateDef {
  const def = templates.find((t) => t.name === DEFAULT_TEMPLATE) ?? templates[0]!
  const defIndex = templates.indexOf(def) + 1
  for (let attempt = 0; attempt < 3; attempt++) {
    print('Select a template:\n')
    for (let i = 0; i < templates.length; i++) print(`  ${i + 1}) ${templates[i]!.name} — ${templates[i]!.description}\n`)
    const raw = read(`Template [${defIndex}]: `)
    if (raw === null) return def
    const input = raw.trim()
    if (input === '') return def
    const asNum = Number.parseInt(input, 10)
    if (!Number.isNaN(asNum) && asNum >= 1 && asNum <= templates.length) return templates[asNum - 1]!
    const byName = templates.find((t) => t.name === input)
    if (byName) return byName
    print(`Invalid selection "${input}". Try again.\n`)
  }
  return def
}
