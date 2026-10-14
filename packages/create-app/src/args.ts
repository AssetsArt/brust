// Argument parsing — a port of 0.1.x `brust new` (runtime/cli/new.ts:12-69).
// Note: `bun create` itself rejects the short flags -t and -y before this bin runs; they work under `bunx @brust/create-app`.
import { isAbsolute, resolve } from 'node:path'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/
const MAX_NAME_LEN = 50
// The same rule as `brust shadcn init` (R41.8): a component is a registry name or an https URL, checked before anything is written.
const COMPONENT_RE = /^[a-z0-9][a-z0-9-]*$/
const REGISTRY_URL_RE = /^https:\/\/[^\s,]+$/

export const USAGE = 'usage: bun create @brust/app <name> [--template blank|pokedex] [--tailwind] [--dir <path>] [--yes] [--brust-dep <spec>] [--shadcn[=button,card,...]] [--version]'

export interface ParsedArgs {
  projectName: string
  targetDir: string
  template?: string
  yes: boolean
  brustDep?: string
  /** `--tailwind` (L21): accepted and ignored since L28: the blank template uses Tailwind CSS v4 by default. */
  tailwind: boolean
  help: boolean
  /** `--shadcn[=a,b]` (F181): after scaffolding, install and run `brust shadcn init` with these components (`[]` = set up only). */
  shadcn?: string[]
  /** `--version` (F131): print the bare version and exit; no short form (see the note above). */
  version: boolean
}

export function parseArgs(args: string[]): ParsedArgs {
  let name: string | undefined
  let dir: string | undefined
  let template: string | undefined
  let brustDep: string | undefined
  let yes = false
  let tailwind = false
  let help = false
  let version = false
  let shadcn: string[] | undefined
  const need = (flag: string, v: string | undefined): string => {
    if (!v) throw new Error(`create-app: ${flag} requires a value`)
    return v
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--') continue
    if (a === '--help' || a === '-h') help = true
    else if (a === '--version') version = true
    else if (a === '--dir') dir = need('--dir', args[++i])
    else if (a.startsWith('--dir=')) dir = need('--dir', a.slice('--dir='.length))
    else if (a === '--template' || a === '-t') template = need('--template', args[++i])
    else if (a.startsWith('--template=')) template = need('--template', a.slice('--template='.length))
    else if (a === '--brust-dep') brustDep = need('--brust-dep', args[++i])
    else if (a.startsWith('--brust-dep=')) brustDep = need('--brust-dep', a.slice('--brust-dep='.length))
    else if (a === '--yes' || a === '-y') yes = true
    else if (a === '--tailwind') tailwind = true
    else if (a === '--shadcn') shadcn = shadcn ?? []
    else if (a.startsWith('--shadcn=')) {
      const names = a.slice('--shadcn='.length).split(',').filter(Boolean)
      for (const c of names) {
        if (!COMPONENT_RE.test(c) && !REGISTRY_URL_RE.test(c)) throw new Error(`create-app: --shadcn component "${c}" must match ^[a-z0-9][a-z0-9-]*$ or be an https:// registry URL (without commas)`)
      }
      shadcn = [...(shadcn ?? []), ...names]
    }
    else if (a.startsWith('-')) throw new Error(`create-app: unknown flag "${a}"`)
    else if (name === undefined) name = a
    else throw new Error(`create-app: unexpected positional argument "${a}"`)
  }

  if (help || version) return { projectName: name ?? '', targetDir: '', template, yes, brustDep, tailwind, help, version }
  if (!name) throw new Error(`create-app: missing project name. ${USAGE}`)
  if (name.length > MAX_NAME_LEN) throw new Error(`create-app: project name too long (max ${MAX_NAME_LEN} chars)`)
  if (!NAME_RE.test(name)) {
    throw new Error(`create-app: invalid project name "${name}" — use lowercase letters, digits, hyphens, underscores; must start with a letter or digit`)
  }
  const cwd = process.cwd()
  const targetDir = dir ? (isAbsolute(dir) ? dir : resolve(cwd, dir)) : resolve(cwd, name)
  return { projectName: name, targetDir, template, yes, brustDep, tailwind, help, version, ...(shadcn && { shadcn }) }
}
