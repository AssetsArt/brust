import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const TEMPLATE_DIR = join(import.meta.dir, 'templates', 'minimal')

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

  try {
    await copyTemplate({
      templateDir: TEMPLATE_DIR,
      targetDir,
      substitutions: {
        __PROJECT_NAME__: projectName,
        __BRUST_DEP__: JSON.stringify(brustRef.spec),
      },
    })
  } catch (e) {
    if (!targetExisted) {
      await rm(targetDir, { recursive: true, force: true }).catch(() => {})
    }
    console.error(`brust new: failed to scaffold (${e instanceof Error ? e.message : String(e)})`)
    process.exit(1)
  }

  printNextSteps(projectName, targetDir)
}

function printNextSteps(name: string, targetDir: string): void {
  const cwd = process.cwd()
  const displayPath = targetDir.startsWith(cwd + '/')
    ? './' + targetDir.slice(cwd.length + 1)
    : targetDir
  console.log(`Created ${name} at ${targetDir}\n`)
  console.log(`Next:`)
  console.log(`  cd ${displayPath}`)
  console.log(`  bun install`)
  console.log(`  bun run dev`)
}
