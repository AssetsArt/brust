// The stand-in packages live in `pkgs/` (node_modules is untracked); the test installs them before the build.
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export function installPackages(root: string): () => void {
  const modules = join(root, 'app', 'node_modules')
  rmSync(modules, { recursive: true, force: true })
  for (const name of readdirSync(join(root, 'pkgs'))) {
    mkdirSync(join(modules, name), { recursive: true })
    cpSync(join(root, 'pkgs', name), join(modules, name), { recursive: true })
  }
  return () => rmSync(modules, { recursive: true, force: true })
}
