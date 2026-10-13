// The fixture package lives in `pkg/` (node_modules is untracked); tests install it before the build.
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export function installTinyFmt(root: string): () => void {
  const dest = join(root, 'node_modules/tiny-fmt')
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  cpSync(join(root, 'pkg'), dest, { recursive: true })
  return () => rmSync(join(root, 'node_modules'), { recursive: true, force: true })
}
