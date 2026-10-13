// The fixture's package lives in `pkg/` (node_modules is untracked); tests install it before the build.
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export function installTinyIcons(app: string): () => void {
  const dest = join(app, 'node_modules/tiny-icons')
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  cpSync(join(app, 'pkg'), dest, { recursive: true })
  return () => rmSync(join(app, 'node_modules'), { recursive: true, force: true })
}
