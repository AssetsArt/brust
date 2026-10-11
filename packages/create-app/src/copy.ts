// copyTemplate — a port of 0.1.x runtime/cli/new.ts:100-163. `*.tmpl` files are substituted and lose the suffix, `_gitignore`
// becomes `.gitignore` (npm silently drops a nested .gitignore from a tarball), everything else is copied byte-for-byte.
// Symlinks are skipped, as in 0.1.x.
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface CopyTemplateOpts {
  templateDir: string
  targetDir: string
  substitutions: Record<string, string>
}

export async function copyTemplate(opts: CopyTemplateOpts): Promise<void> {
  if (!existsSync(opts.templateDir)) {
    throw new Error(`create-app: template directory not found at ${opts.templateDir}; this is a @brust/create-app installation bug`)
  }
  await copyDir(opts.templateDir, opts.targetDir, opts.substitutions)
}

async function copyDir(src: string, dst: string, subs: Record<string, string>): Promise<void> {
  await mkdir(dst, { recursive: true })
  for (const ent of await readdir(src, { withFileTypes: true })) {
    const srcPath = join(src, ent.name)
    const dstPath = join(dst, renameForEmit(ent.name))
    if (ent.isDirectory()) await copyDir(srcPath, dstPath, subs)
    else if (ent.isFile()) {
      if (ent.name.endsWith('.tmpl')) await writeFile(dstPath, applySubstitutions(await readFile(srcPath, 'utf8'), subs))
      else await writeFile(dstPath, await readFile(srcPath))
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
  for (const [key, value] of Object.entries(subs)) out = out.split(key).join(value)
  return out
}
