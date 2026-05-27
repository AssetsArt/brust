import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/
const MAX_NAME_LEN = 50

export interface ParsedNewArgs {
  projectName: string
  targetDir: string
}

export function parseArgs(args: string[]): ParsedNewArgs {
  let name: string | undefined
  let dir: string | undefined

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--dir') {
      dir = args[++i]
      if (!dir) throw new Error('brust new: --dir requires a value')
    } else if (a.startsWith('--dir=')) {
      dir = a.slice('--dir='.length)
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
  const targetDir = dir
    ? (isAbsolute(dir) ? dir : resolve(cwd, dir))
    : resolve(cwd, name)

  return { projectName: name, targetDir }
}

export interface BrustRef {
  kind: 'file' | 'version'
  spec: string  // JSON-encoded string value (e.g. "file:/abs" or "^0.1.0")
}

function hasSourceMarkers(dir: string): boolean {
  return existsSync(join(dir, 'Cargo.toml'))
    && existsSync(join(dir, 'src'))
    && existsSync(join(dir, 'runtime/cli/index.ts'))
}

export function resolveBrustRef(startDir: string = import.meta.dir): BrustRef {
  let dir = startDir
  while (true) {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        if (pkg.name === 'brust') {
          if (hasSourceMarkers(dir)) {
            return { kind: 'file', spec: `file:${dir}` }
          }
          const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0'
          return { kind: 'version', spec: `^${version}` }
        }
      } catch {
        // malformed package.json — keep walking
      }
    }
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error('brust new: cannot locate the brust package — is your installation intact?')
    }
    dir = parent
  }
}

export interface CopyTemplateOpts {
  templateDir: string
  targetDir: string
  substitutions: Record<string, string>
}

export async function copyTemplate(opts: CopyTemplateOpts): Promise<void> {
  if (!existsSync(opts.templateDir)) {
    throw new Error(`brust new: template directory not found at ${opts.templateDir}; this is a brust installation bug`)
  }
  await copyDir(opts.templateDir, opts.targetDir, opts.substitutions)
}

async function copyDir(src: string, dst: string, subs: Record<string, string>): Promise<void> {
  await mkdir(dst, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const ent of entries) {
    const srcPath = join(src, ent.name)
    const dstName = renameForEmit(ent.name)
    const dstPath = join(dst, dstName)
    if (ent.isDirectory()) {
      await copyDir(srcPath, dstPath, subs)
    } else if (ent.isFile()) {
      const isTmpl = ent.name.endsWith('.tmpl')
      if (isTmpl) {
        const raw = await readFile(srcPath, 'utf8')
        const out = applySubstitutions(raw, subs)
        await writeFile(dstPath, out)
      } else {
        const buf = await readFile(srcPath)
        await writeFile(dstPath, buf)
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

export async function runNew(_args: string[]): Promise<void> {
  throw new Error('not implemented')
}
