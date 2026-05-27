import { isAbsolute, resolve } from 'node:path'

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

export async function runNew(_args: string[]): Promise<void> {
  throw new Error('not implemented')
}
