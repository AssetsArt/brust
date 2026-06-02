import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  DEFAULT_TEMPLATE,
  type EmittedFile,
  findBrustPackageRoot,
  listTemplates,
  type TemplateDef,
} from './templates.ts'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/
const MAX_NAME_LEN = 50

export interface ParsedNewArgs {
  projectName: string
  targetDir: string
  template?: string
  yes: boolean
}

export function parseArgs(args: string[]): ParsedNewArgs {
  let name: string | undefined
  let dir: string | undefined
  let template: string | undefined
  let yes = false

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--dir') {
      dir = args[++i]
      if (!dir) throw new Error('brust new: --dir requires a value')
    } else if (a.startsWith('--dir=')) {
      dir = a.slice('--dir='.length)
      if (!dir) throw new Error('brust new: --dir requires a value')
    } else if (a === '--template' || a === '-t') {
      template = args[++i]
      if (!template) throw new Error('brust new: --template requires a value')
    } else if (a.startsWith('--template=')) {
      template = a.slice('--template='.length)
      if (!template) throw new Error('brust new: --template requires a value')
    } else if (a === '--yes' || a === '-y') {
      yes = true
    } else if (a.startsWith('-')) {
      throw new Error(`brust new: unknown flag "${a}"`)
    } else if (name === undefined) {
      name = a
    } else {
      throw new Error(`brust new: unexpected positional argument "${a}"`)
    }
  }

  if (!name) {
    throw new Error('brust new: missing project name. Usage: brust new <name> [--dir <path>]')
  }
  if (name.length > MAX_NAME_LEN) {
    throw new Error(`brust new: project name too long (max ${MAX_NAME_LEN} chars)`)
  }
  if (!NAME_RE.test(name)) {
    throw new Error(
      `brust new: invalid project name "${name}" — use lowercase letters, digits, hyphens, underscores; must start with a letter or digit`,
    )
  }

  const cwd = process.cwd()
  const targetDir = dir ? (isAbsolute(dir) ? dir : resolve(cwd, dir)) : resolve(cwd, name)

  return { projectName: name, targetDir, template, yes }
}

export interface BrustRef {
  kind: 'file' | 'version'
  spec: string // JSON-encoded string value (e.g. "file:/abs" or "^0.1.0")
}

function hasSourceMarkers(dir: string): boolean {
  // Post-2026-05-28 workspace refactor: brust source layout is
  //   <root>/Cargo.toml         (workspace)
  //   <root>/crates/brust/      (the brust cdylib crate)
  //   <root>/runtime/cli/...
  // Pre-refactor layout had `<root>/src/` instead of `<root>/crates/brust/`;
  // we no longer check `<root>/src` because the workspace root never has one.
  return (
    existsSync(join(dir, 'Cargo.toml')) &&
    existsSync(join(dir, 'crates/brust/src')) &&
    existsSync(join(dir, 'runtime/cli/index.ts'))
  )
}

export function resolveBrustRef(startDir: string = import.meta.dir): BrustRef {
  const dir = findBrustPackageRoot(startDir)
  if (hasSourceMarkers(dir)) {
    return { kind: 'file', spec: `file:${dir}` }
  }
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  return { kind: 'version', spec: `^${version}` }
}

export interface CopyTemplateOpts {
  templateDir: string
  targetDir: string
  substitutions: Record<string, string>
  exclude?: Set<string>
  extraFiles?: EmittedFile[]
}

export async function copyTemplate(opts: CopyTemplateOpts): Promise<void> {
  if (!existsSync(opts.templateDir)) {
    throw new Error(
      `brust new: template directory not found at ${opts.templateDir}; this is a brust installation bug`,
    )
  }
  await copyDir(opts.templateDir, opts.targetDir, opts.substitutions, opts.exclude ?? new Set(), '')
  for (const f of opts.extraFiles ?? []) {
    const dstPath = join(opts.targetDir, f.relPath)
    await mkdir(dirname(dstPath), { recursive: true })
    await writeFile(dstPath, f.content)
  }
}

async function copyDir(
  src: string,
  dst: string,
  subs: Record<string, string>,
  exclude: Set<string>,
  relBase: string,
): Promise<void> {
  await mkdir(dst, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const ent of entries) {
    const relPath = relBase ? `${relBase}/${ent.name}` : ent.name
    if (exclude.has(relPath)) continue
    const srcPath = join(src, ent.name)
    const dstName = renameForEmit(ent.name)
    const dstPath = join(dst, dstName)
    if (ent.isDirectory()) {
      await copyDir(srcPath, dstPath, subs, exclude, relPath)
    } else if (ent.isFile()) {
      const isTmpl = ent.name.endsWith('.tmpl')
      if (isTmpl) {
        const raw = await readFile(srcPath, 'utf8')
        await writeFile(dstPath, applySubstitutions(raw, subs))
      } else {
        await writeFile(dstPath, await readFile(srcPath))
      }
    }
  }
}

function renameForEmit(name: string): string {
  if (name.endsWith('.tmpl')) return name.slice(0, -'.tmpl'.length)
  if (name === '_gitignore') return '.gitignore'
  return name
}

function applySubstitutions(text: string, subs: Record<string, string>): string {
  let out = text
  for (const [key, value] of Object.entries(subs)) {
    out = out.split(key).join(value)
  }
  return out
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
    if (!t) {
      throw new Error(
        `brust new: unknown template "${opts.explicit}" — choose one of: ${templates
          .map((x) => x.name)
          .join(', ')}`,
      )
    }
    return t
  }
  if (opts.yes || !opts.isTTY) {
    return templates.find((t) => t.name === DEFAULT_TEMPLATE) ?? templates[0]!
  }
  const read = opts.read ?? ((label: string) => prompt(label))
  const print = opts.print ?? ((s: string) => process.stdout.write(s))
  return promptPicker(templates, read, print)
}

function promptPicker(
  templates: TemplateDef[],
  read: (label: string) => string | null,
  print: (s: string) => void,
): TemplateDef {
  const def = templates.find((t) => t.name === DEFAULT_TEMPLATE) ?? templates[0]!
  const defIndex = templates.indexOf(def) + 1
  for (let attempt = 0; attempt < 3; attempt++) {
    print('Select a template:\n')
    for (let i = 0; i < templates.length; i++) {
      const t = templates[i]!
      print(`  ${i + 1}) ${t.name} — ${t.description}\n`)
    }
    const raw = read(`Template [${defIndex}]: `)
    if (raw === null) return def
    const input = raw.trim()
    if (input === '') return def
    const asNum = Number.parseInt(input, 10)
    if (!Number.isNaN(asNum) && asNum >= 1 && asNum <= templates.length) {
      return templates[asNum - 1]!
    }
    const byName = templates.find((t) => t.name === input)
    if (byName) return byName
    print(`Invalid selection "${input}". Try again.\n`)
  }
  return def
}

export async function runNew(args: string[]): Promise<void> {
  let parsed: ParsedNewArgs
  try {
    parsed = parseArgs(args)
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }

  const { projectName, targetDir } = parsed

  const targetExisted = existsSync(targetDir)
  if (targetExisted) {
    const entries = await readdir(targetDir)
    if (entries.length > 0) {
      console.error(`brust new: target directory "${targetDir}" is not empty`)
      process.exit(1)
    }
  }

  let brustRef: BrustRef
  try {
    brustRef = resolveBrustRef()
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }

  let tmpl: TemplateDef
  try {
    tmpl = selectTemplate({
      explicit: parsed.template,
      yes: parsed.yes,
      isTTY: Boolean(process.stdin.isTTY),
    })
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }

  try {
    await copyTemplate({
      templateDir: tmpl.sourceDir,
      targetDir,
      substitutions: {
        __PROJECT_NAME__: projectName,
        __BRUST_DEP__: JSON.stringify(brustRef.spec),
      },
      exclude: tmpl.exclude,
      extraFiles: tmpl.extraFiles?.({ projectName, brustSpec: brustRef.spec }),
    })
  } catch (e) {
    if (!targetExisted) {
      await rm(targetDir, { recursive: true, force: true }).catch(() => {})
    }
    console.error(`brust new: failed to scaffold (${e instanceof Error ? e.message : String(e)})`)
    process.exit(1)
  }

  printNextSteps(projectName, targetDir, tmpl.name)
}

function printNextSteps(name: string, targetDir: string, template: string): void {
  const cwd = process.cwd()
  const displayPath = targetDir.startsWith(`${cwd}/`)
    ? `./${targetDir.slice(cwd.length + 1)}`
    : targetDir
  console.log(`Created ${name} at ${targetDir} (template: ${template})\n`)
  console.log('Next:')
  console.log(`  cd ${displayPath}`)
  console.log('  bun install')
  console.log('  bun run dev')
}
