// The fixture package lives in `pkg/` (node_modules is untracked); the test installs it before the build.
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export function installPlainFmt(root: string): () => void {
  const dest = join(root, 'app/node_modules/plain-fmt')
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  cpSync(join(root, 'pkg'), dest, { recursive: true })
  return () => rmSync(join(root, 'app/node_modules'), { recursive: true, force: true })
}
